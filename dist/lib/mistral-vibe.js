import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
export const VIBE_QUOTA_OUTPUT_LIMIT = 64 * 1024;
const PLANS = new Set(["FREE", "INDIVIDUAL", "PRO", "EDU", "TEAM", "ENTERPRISE"]);
const FAILURE_STATES = new Set([
    "missing_runtime",
    "unsupported_runtime",
    "missing_auth",
    "unavailable",
    "failed",
    "timeout",
    "invalid_response",
]);
export function parseMistralVibeQuota(text) {
    const invalid = { status: "invalid_response" };
    if (Buffer.byteLength(text) > VIBE_QUOTA_OUTPUT_LIMIT)
        return invalid;
    let value;
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return invalid;
        value = parsed;
    }
    catch {
        return invalid;
    }
    if (typeof value.status !== "string")
        return invalid;
    if (FAILURE_STATES.has(value.status))
        return { status: value.status };
    if (value.status !== "ok" ||
        typeof value.usedPercent !== "number" ||
        !Number.isFinite(value.usedPercent) ||
        value.usedPercent < 0 ||
        value.usedPercent > 1e15) {
        return invalid;
    }
    let resetTimeIso;
    if (typeof value.resetTimeIso === "string" &&
        value.resetTimeIso.length <= 128 &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.resetTimeIso) &&
        Number.isFinite(Date.parse(value.resetTimeIso))) {
        resetTimeIso = new Date(value.resetTimeIso).toISOString();
    }
    return {
        status: "ok",
        usedPercent: value.usedPercent,
        ...(resetTimeIso ? { resetTimeIso } : {}),
        ...(typeof value.plan === "string" && PLANS.has(value.plan) ? { plan: value.plan } : {}),
        ...(typeof value.paygEnabled === "boolean" ? { paygEnabled: value.paygEnabled } : {}),
    };
}
export async function resolveVibePython(params) {
    const env = params.env ?? process.env;
    const home = params.home ?? homedir();
    const workspace = await realpath(params.workspaceRoot).catch(() => resolve(params.workspaceRoot));
    const inWorkspace = (file) => {
        if (workspace === resolve(home))
            return false;
        const path = relative(workspace, file);
        return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
    };
    const trustedExecutable = async (file) => {
        if (!isAbsolute(file) || inWorkspace(resolve(file)))
            return false;
        try {
            if (inWorkspace(await realpath(file)))
                return false;
            await access(file, constants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    };
    if (env.OPENCODE_VIBE_PYTHON) {
        return (await trustedExecutable(env.OPENCODE_VIBE_PYTHON)) ? env.OPENCODE_VIBE_PYTHON : null;
    }
    const paths = env.OPENCODE_VIBE_PATH
        ? [env.OPENCODE_VIBE_PATH]
        : [
            ...(env.PATH ?? "")
                .split(delimiter)
                .map((directory) => directory.trim())
                .filter((directory) => isAbsolute(directory) && !inWorkspace(resolve(directory)))
                .map((directory) => join(directory, "vibe")),
            join(home, ".local", "bin", "vibe"),
        ];
    for (const candidate of paths) {
        if (!(await trustedExecutable(candidate)))
            continue;
        const target = await realpath(candidate);
        const python = join(dirname(target), process.platform === "win32" ? "python.exe" : "python");
        if (await trustedExecutable(python))
            return python;
    }
    return null;
}
export function runVibeQuota(python, timeoutMs, env = process.env) {
    return new Promise((done) => {
        let finished = false;
        let size = 0;
        const chunks = [];
        let timer;
        const finish = (result) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            done(result);
        };
        try {
            const child = spawn(python, ["-I", "-u", fileURLToPath(new URL("./mistral-vibe-quota.py", import.meta.url))], { cwd: homedir(), env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
            timer = setTimeout(() => {
                child.kill("SIGKILL");
                finish({ status: "timeout" });
            }, Math.min(30_000, Math.max(1, timeoutMs)));
            timer.unref();
            child.stdout.on("data", (chunk) => {
                if (finished)
                    return;
                size += chunk.length;
                if (size > VIBE_QUOTA_OUTPUT_LIMIT) {
                    child.kill("SIGKILL");
                    finish({ status: "invalid_response" });
                }
                else {
                    chunks.push(chunk);
                }
            });
            child.once("error", () => finish({ status: "failed" }));
            child.once("close", (code) => {
                finish(code === 0
                    ? parseMistralVibeQuota(Buffer.concat(chunks).toString("utf8"))
                    : { status: "failed" });
            });
        }
        catch {
            finish({ status: "failed" });
        }
    });
}
export async function queryMistralVibeQuota(params) {
    const python = await resolveVibePython(params);
    return python ? runVibeQuota(python, params.requestTimeoutMs) : { status: "missing_runtime" };
}
//# sourceMappingURL=mistral-vibe.js.map