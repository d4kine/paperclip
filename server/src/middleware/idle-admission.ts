import { markIdleIngressTracked } from "../services/idle-local-work.js";
import type { Application, Request, RequestHandler } from "express";
import { beginIdleTrackedWork, isIdleTaskDrainActive } from "../services/task-admission.js";

type RequestWork = { pending: number; ended: boolean; finish: () => void };
const requests = new WeakMap<Request, RequestWork>();
function settle(work: RequestWork) {
  if (work.ended && work.pending === 0) work.finish();
}

// Only the exact control endpoint and health probes bypass admission. The
// control route still authenticates each operation. GET is otherwise tracked:
// OAuth callbacks and tool streams can create work too.
function isControlRequest(req: Request) {
  const path = req.path.replace(/\/$/, "");
  return (path === "/api/instance/task-drain" && ["GET", "POST", "DELETE"].includes(req.method)) ||
    (path === "/api/health" && ["GET", "HEAD"].includes(req.method));
}

/** Install before body parsers, auth, webhooks and tool ingress. */
export const idleAdmissionMiddleware: RequestHandler = (req, res, next) => {
  if (isControlRequest(req)) { next(); return; }
  if (isIdleTaskDrainActive()) {
    res.set("Retry-After", "1").status(503).json({ error: "instance_preparing_to_sleep" });
    return;
  }
  const work: RequestWork = { pending: 0, ended: false, finish: beginIdleTrackedWork() };
  requests.set(req, work);
  // close/aborted are NOT completion: an async handler can still be committing
  // a mutation after its client leaves. Wait for the application's end and all
  // returned handler promises. A handler abandoned without end stays a blocker.
  const end = res.end;
  res.end = function (this: typeof res, ...args: Parameters<typeof end>) {
    try { return end.apply(this, args); }
    finally { work.ended = true; settle(work); }
  } as typeof end;
  next();
};

// Express 5 exposes its router stack. Walk it once after route registration,
// preserving router objects and error-handler arity. Waiting only for finish
// loses async work after res.json(), including the disconnected-client case.
// Keep this adapter isolated and exercise it against real Express in tests.
type Layer = { handle: Function & { stack?: Layer[] }; route?: { stack: Layer[] } };
export function trackIdleRequestHandlers(app: Application): void {
  const seen = new Set<Layer>();
  const visit = (stack: Layer[]) => {
    for (const layer of stack) {
      if (seen.has(layer)) continue;
      seen.add(layer);
      if (layer.route) { visit(layer.route.stack); continue; }
      if (layer.handle.stack) { visit(layer.handle.stack); continue; }
      const original = layer.handle;
      if (original === idleAdmissionMiddleware) continue;
      const invoke = (req: Request, args: unknown[]) => {
        const work = requests.get(req);
        if (!work) return original(...args);
        work.pending++;
        const finish = () => { work.pending--; settle(work); };
        try {
          const result = original(...args);
          if (result && typeof result.then === "function") return Promise.resolve(result).finally(finish);
          finish();
          return result;
        } catch (error) { finish(); throw error; }
      };
      layer.handle = original.length === 4
        ? function (error: unknown, req: Request, res: unknown, next: unknown) { return invoke(req, [error, req, res, next]); }
        : function (req: Request, res: unknown, next: unknown) { return invoke(req, [req, res, next]); };
    }
  };
  visit(app.router.stack as Layer[]);
  markIdleIngressTracked();
}
