import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { runVibeQuota } from "../src/lib/mistral-vibe.js";

const python = process.env.VIBE_TEST_PYTHON;

it.skipIf(!python)(
  "reads billing with the real Vibe runtime, dummy credentials and loopback HTTP only",
  async () => {
    if (!python) throw new Error("VIBE_TEST_PYTHON must select an installed Vibe runtime");
    const home = await mkdtemp(join(tmpdir(), "quota-vibe-http-"));
    const requests: string[] = [];
    let offline = false;
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      expect(request.headers.authorization).toBe("Bearer fixture-only");
      expect(request.method).toBe("GET");
      response.setHeader("content-type", "application/json");
      if (offline) {
        response.writeHead(403).end('{"message":"fixture-only must not escape"}');
      } else if (request.url === "/v1/billing/subscription") {
        response.end(JSON.stringify({ plan_name: "EDU", vibe_payg_enabled: false }));
      } else if (request.url === "/v1/billing/budget") {
        response.end(
          JSON.stringify({
            vibe_budget: {
              usage_percentage: 25,
              initial_budget: 100,
              reset_at: "2026-12-01T00:00:00Z",
            },
          }),
        );
      } else {
        response.writeHead(404).end("{}");
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      await writeFile(
        join(home, "config.toml"),
        `
active_model = "fixture"
[[providers]]
name = "mistral"
backend = "mistral"
api_base = "http://127.0.0.1:${port}/v1"
api_key_env_var = "VIBE_QUOTA_FIXTURE_KEY"
[[models]]
name = "fixture-model"
provider = "mistral"
alias = "fixture"
`,
      );
      const env = {
        HOME: home,
        VIBE_HOME: home,
        VIBE_QUOTA_FIXTURE_KEY: "fixture-only",
        PATH: process.env.PATH,
      };
      const quota = await runVibeQuota(python, 10_000, env);
      expect(quota).toEqual({
        status: "ok",
        usedPercent: 25,
        plan: "EDU",
        paygEnabled: false,
        resetTimeIso: "2026-12-01T00:00:00.000Z",
      });
      expect(requests.sort()).toEqual(["/v1/billing/budget", "/v1/billing/subscription"]);
      expect(JSON.stringify(quota)).not.toContain("fixture-only");
      offline = true;
      expect(await runVibeQuota(python, 10_000, env)).toEqual({
        status: "unavailable",
      });
      const count = requests.length;
      expect(
        await runVibeQuota(python, 10_000, {
          ...env,
          VIBE_QUOTA_FIXTURE_KEY: "",
        }),
      ).toEqual({ status: "missing_auth" });
      expect(requests).toHaveLength(count);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
);
