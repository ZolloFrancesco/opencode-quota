/**
 * OpenCode Quota Plugin
 *
 * Shows quota status in OpenCode without LLM invocation.
 *
 * @packageDocumentation
 */
// Re-export types for consumers (types are erased at runtime, so safe to export)
export { QUOTA_PROVIDER_MODES, QUOTA_PROVIDER_REMOTE_FORMATS, QUOTA_PROVIDER_WINDOW_TYPES, validateQuotaProviders, } from "./lib/quota-providers.js";
export { default } from "./plugin.js";
//# sourceMappingURL=index.js.map