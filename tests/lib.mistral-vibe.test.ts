import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import {
  parseMistralVibeQuota,
  resolveVibePython,
  runVibeQuota,
  VIBE_QUOTA_OUTPUT_LIMIT,
} from "../src/lib/mistral-vibe.js";

describe("Mistral Vibe quota protocol", () => {
  it("keeps percentage points and only allowlisted metadata", () => {
    expect(
      parseMistralVibeQuota(
        JSON.stringify({
          status: "ok",
          usedPercent: 0.25,
          plan: "EDU",
          paygEnabled: false,
          resetTimeIso: "2026-12-01T01:00:00+01:00",
          token: "not-for-output",
        }),
      ),
    ).toEqual({
      status: "ok",
      usedPercent: 0.25,
      plan: "EDU",
      paygEnabled: false,
      resetTimeIso: "2026-12-01T00:00:00.000Z",
    });
  });
  it.each([
    null,
    [],
    {},
    { status: "ok" },
    { status: "ok", usedPercent: "25" },
    { status: "ok", usedPercent: -1 },
    { status: "ok", usedPercent: 1e20 },
  ])("rejects malformed quota without inventing zero (%j)", (value) => {
    expect(parseMistralVibeQuota(JSON.stringify(value))).toEqual({ status: "invalid_response" });
  });
  it("retains over-quota use and omits unknown plan and invalid reset", () => {
    expect(
      parseMistralVibeQuota(
        JSON.stringify({
          status: "ok",
          usedPercent: 125,
          plan: "secret",
          resetTimeIso: "tomorrow",
        }),
      ),
    ).toEqual({ status: "ok", usedPercent: 125 });
    expect(parseMistralVibeQuota('{"status":"failed","message":"secret"}')).toEqual({
      status: "failed",
    });
    expect(parseMistralVibeQuota("secret".repeat(VIBE_QUOTA_OUTPUT_LIMIT))).toEqual({
      status: "invalid_response",
    });
  });
});

describe("Mistral Vibe process boundary", () => {
  let child: EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    mocks.spawn.mockReset();
    child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
    mocks.spawn.mockReturnValue(child);
  });
  it("uses a fixed isolated Python script, ignores stderr and safely joins chunks", async () => {
    const pending = runVibeQuota("/trusted/python", 5000);
    child.stdout.write('{"status":"ok",');
    child.stdout.write('"usedPercent":25}');
    child.emit("close", 0);
    expect(await pending).toEqual({ status: "ok", usedPercent: 25 });
    const [file, args, options] = mocks.spawn.mock.calls[0];
    expect(file).toBe("/trusted/python");
    expect(args.slice(0, 2)).toEqual(["-I", "-u"]);
    expect(args[2]).toMatch(/mistral-vibe-quota\.py$/);
    expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
    expect(options.shell).toBeUndefined();
  });
  it("kills only its owned process on timeout", async () => {
    vi.useFakeTimers();
    const pending = runVibeQuota("/trusted/python", 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual({ status: "timeout" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("bounds output and suppresses raw process failures", async () => {
    const oversized = runVibeQuota("/trusted/python", 5000);
    child.stdout.write(Buffer.alloc(VIBE_QUOTA_OUTPUT_LIMIT + 1));
    expect(await oversized).toEqual({ status: "invalid_response" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    const failed = runVibeQuota("/trusted/python", 5000);
    child.emit("error", new Error("Authorization: secret"));
    expect(await failed).toEqual({ status: "failed" });
  });
});

describe("trusted Vibe Python discovery", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "quota-vibe-discovery-"));
    roots.push(root);
    const home = join(root, "home");
    const workspaceRoot = join(root, "project");
    const bin = join(root, "uv", "bin");
    for (const dir of [join(home, ".local", "bin"), workspaceRoot, bin])
      await mkdir(dir, { recursive: true });
    for (const name of ["vibe", "python"])
      await writeFile(join(bin, name), "fixture", { mode: 0o755 });
    return { home, workspaceRoot, bin };
  }
  it("finds the uv sibling interpreter without resolving away the virtualenv", async () => {
    const f = await fixture();
    await symlink(join(f.bin, "vibe"), join(f.home, ".local", "bin", "vibe"));
    expect(await resolveVibePython({ ...f, env: { PATH: "" } })).toBe(join(f.bin, "python"));
  });
  it("honors an explicit absolute interpreter and rejects relative/workspace paths", async () => {
    const f = await fixture();
    expect(
      await resolveVibePython({ ...f, env: { OPENCODE_VIBE_PYTHON: join(f.bin, "python") } }),
    ).toBe(join(f.bin, "python"));
    expect(await resolveVibePython({ ...f, env: { OPENCODE_VIBE_PYTHON: "./python" } })).toBeNull();
    await writeFile(join(f.workspaceRoot, "python"), "untrusted", { mode: 0o755 });
    expect(
      await resolveVibePython({
        ...f,
        env: { OPENCODE_VIBE_PYTHON: join(f.workspaceRoot, "python") },
      }),
    ).toBeNull();
  });
  it("rejects PATH entries and symlink targets inside the project", async () => {
    const f = await fixture();
    await writeFile(join(f.workspaceRoot, "vibe"), "untrusted", { mode: 0o755 });
    expect(await resolveVibePython({ ...f, env: { PATH: `.:${f.workspaceRoot}` } })).toBeNull();
    await symlink(join(f.workspaceRoot, "vibe"), join(f.home, ".local", "bin", "vibe"));
    expect(await resolveVibePython({ ...f, env: { PATH: "" } })).toBeNull();
  });
});
