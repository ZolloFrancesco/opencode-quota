import type { QuotaProvider } from "../lib/entries.js";
import { queryMistralVibeQuota, resolveVibePython } from "../lib/mistral-vibe.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { failedAccount, MONTHLY, quotaRow } from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

const LABEL = "Mistral Vibe";
const ERRORS = {
  missing_runtime: "Install mistral-vibe with uv, or set OPENCODE_VIBE_PYTHON on the server.",
  unsupported_runtime:
    "Vibe's billing interface requires a supported mistral-vibe 3.1.x runtime (tested with 3.1.2).",
  missing_auth: "Vibe login is missing. Run vibe --setup on the OpenCode server.",
  unavailable: "Vibe did not return an allowance. Check account permissions and billing access.",
  failed: "Could not read Vibe billing data. Credentials and provider errors were not exposed.",
  timeout: "Vibe billing request timed out.",
  invalid_response: "Vibe returned an invalid quota response.",
} as const;

export const mistralVibeProvider: QuotaProvider = {
  id: "mistral-vibe",
  // No account-neutral cache: the active Vibe login may change outside OpenCode.
  cachePolicy: { kind: "uncached" },
  async isAvailable(ctx) {
    if (!ctx.config.automaticDiscovery && ctx.config.enabledProviders?.includes("mistral-vibe")) {
      return true;
    }
    if (
      await isCanonicalProviderAvailable({
        ctx,
        providerId: "mistral-vibe",
        fallbackOnError: false,
      })
    ) {
      return true;
    }
    // CLI reports do not see providers contributed by a running companion.
    // Executable discovery reads no credentials and makes no network request.
    return (await resolveVibePython({ workspaceRoot: ctx.workspaceRoot })) !== null;
  },
  matchesCurrentModel(model, context) {
    return context?.currentProviderID
      ? context.currentProviderID === "mistral-vibe"
      : modelProviderMatchesRuntimeId(model, "mistral-vibe");
  },
  async fetch(ctx) {
    const result = await queryMistralVibeQuota({
      workspaceRoot: ctx.workspaceRoot,
      requestTimeoutMs: ctx.config.requestTimeoutMs ?? 10_000,
    });
    if (result.status !== "ok") {
      return {
        attempted: true,
        accounts: [failedAccount(LABEL, ERRORS[result.status])],
        debug: [{ key: "failure_kind", value: result.status }],
      };
    }
    return {
      attempted: true,
      accounts: [
        {
          name: LABEL,
          rows: [
            quotaRow({
              ...MONTHLY,
              percentRemaining: 100 - result.usedPercent,
              resetsAt: result.resetTimeIso,
            }),
          ],
          errors: [],
        },
      ],
      debug: statusDetailsFromRecord({
        quota_source: "Vibe billing API (native Python credential resolver)",
        plan: result.plan,
        payg_enabled: result.paygEnabled === undefined ? undefined : String(result.paygEnabled),
      }),
    };
  },
};
