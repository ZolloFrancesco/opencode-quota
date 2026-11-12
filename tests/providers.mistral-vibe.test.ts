import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { rowsFromProviderResult } from "../src/core/rows.js";
import { queryMistralVibeQuota, resolveVibePython } from "../src/lib/mistral-vibe.js";
import { mistralVibeProvider } from "../src/providers/mistral-vibe.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/mistral-vibe.js", () => ({
  queryMistralVibeQuota: vi.fn(),
  resolveVibePython: vi.fn(),
}));

describe("Mistral Vibe v6 provider", () => {
  beforeEach(() => {
    vi.mocked(queryMistralVibeQuota).mockReset();
    vi.mocked(resolveVibePython).mockReset().mockResolvedValue(null);
  });
  it("discovers the companion runtime or an installed Vibe interpreter, without querying billing", async () => {
    expect(
      await mistralVibeProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["mistral-vibe"] }),
      ),
    ).toBe(true);
    expect(
      await mistralVibeProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["mistral"] }),
      ),
    ).toBe(false);
    vi.mocked(resolveVibePython).mockResolvedValue("/trusted/python");
    expect(await mistralVibeProvider.isAvailable(createProviderAvailabilityContext())).toBe(true);
    expect(queryMistralVibeQuota).not.toHaveBeenCalled();
  });
  it("allows an explicit selection but does not enroll the provider just because automatic discovery lists it", async () => {
    expect(
      await mistralVibeProvider.isAvailable(
        createProviderAvailabilityContext({
          configOverrides: { enabledProviders: ["mistral-vibe"], automaticDiscovery: false },
        }),
      ),
    ).toBe(true);
    expect(
      await mistralVibeProvider.isAvailable(
        createProviderAvailabilityContext({
          configOverrides: { enabledProviders: ["mistral-vibe"], automaticDiscovery: true },
        }),
      ),
    ).toBe(false);
  });
  it("matches only Vibe models", () => {
    expect(mistralVibeProvider.matchesCurrentModel?.("mistral-vibe/model#high")).toBe(true);
    expect(mistralVibeProvider.matchesCurrentModel?.("mistral/model")).toBe(false);
  });
  it("returns a validated v6 monthly row with the real percent and reset", async () => {
    vi.mocked(queryMistralVibeQuota).mockResolvedValue({
      status: "ok",
      usedPercent: 0.25,
      plan: "EDU",
      resetTimeIso: "2026-12-01T00:00:00.000Z",
    });
    const result = await mistralVibeProvider.fetch({
      workspaceRoot: "/project",
      config: { requestTimeoutMs: 5000 },
    } as never);
    expect(queryMistralVibeQuota).toHaveBeenCalledWith({
      workspaceRoot: "/project",
      requestTimeoutMs: 5000,
    });
    const normalized = rowsFromProviderResult("mistral-vibe", result);
    expect(normalized.error).toBeUndefined();
    expect(normalized.rows).toHaveLength(1);
    expect(normalized.rows[0]).toMatchObject({
      id: "mistral-vibe.monthly",
      providerId: "mistral-vibe",
      type: "quota",
      method: "remote_api",
      authority: "provider_reported",
      window: "month",
      percentRemaining: 99.75,
      resetsAt: "2026-12-01T00:00:00.000Z",
    });
    expect(JSON.stringify(normalized.rows)).not.toMatch(/\bUSD\b|five.hour|weekly/);
  });
  it("preserves overage and omits an unknown reset", async () => {
    vi.mocked(queryMistralVibeQuota).mockResolvedValue({ status: "ok", usedPercent: 125 });
    const result = await mistralVibeProvider.fetch({
      workspaceRoot: "/project",
      config: {},
    } as never);
    expect(result.accounts[0]?.rows[0]).toMatchObject({ percentRemaining: -25 });
    expect(result.accounts[0]?.rows[0]).not.toHaveProperty("resetsAt");
  });
  it.each([
    "unavailable",
    "missing_auth",
    "missing_runtime",
    "unsupported_runtime",
    "timeout",
    "invalid_response",
    "failed",
  ] as const)("does not turn %s into zero quota", async (status) => {
    vi.mocked(queryMistralVibeQuota).mockResolvedValue({ status });
    const result = await mistralVibeProvider.fetch({
      workspaceRoot: "/project",
      config: {},
    } as never);
    expect(result.accounts[0]?.rows).toEqual([]);
    expect(result.accounts[0]?.errors).toHaveLength(1);
  });
});
