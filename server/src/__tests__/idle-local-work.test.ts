import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectIdleSpool, readIdleLocalWork } from "../services/idle-local-work.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "idle-spool-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
describe("idle cleanup inspection", () => {
  it("refuses to authorize sleep until startup and ingress tracking are ready", async () => {
    expect(await readIdleLocalWork()).toBe("unknown");
  });
  it("accepts absent and empty directories", async () => {
    expect(await inspectIdleSpool(path.join(root, "absent"))).toBe("none");
    expect(await inspectIdleSpool(root)).toBe("none");
  });
  it.each(["receipt.json", "malformed.json", "partial.tmp", "write.probe", "unexpected"])("retains every spool entry: %s", async name => {
    await fs.writeFile(path.join(root, name), "not valid JSON");
    expect(await inspectIdleSpool(root)).toBe("present");
    await fs.rm(path.join(root, name));
    expect(await inspectIdleSpool(root)).toBe("none");
  });
  it("fails closed on a non-directory, dangling symlink, or read failure", async () => {
    const file = path.join(root, "file"), link = path.join(root, "link");
    await fs.writeFile(file, "");
    await fs.symlink(path.join(root, "missing"), link);
    expect(await inspectIdleSpool(file)).toBe("unknown");
    expect(await inspectIdleSpool(path.join(file, "nested"))).toBe("unknown");
    expect(await inspectIdleSpool(link)).toBe("unknown");
    vi.spyOn(fs, "opendir").mockRejectedValue(Object.assign(new Error("private path"), { code: "EACCES" }));
    expect(await inspectIdleSpool(root)).toBe("unknown");
  });
});
