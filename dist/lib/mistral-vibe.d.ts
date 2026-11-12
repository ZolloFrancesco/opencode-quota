export declare const VIBE_QUOTA_OUTPUT_LIMIT: number;
type FailureStatus = "missing_runtime" | "unsupported_runtime" | "missing_auth" | "unavailable" | "failed" | "timeout" | "invalid_response";
export type MistralVibeQuotaResult = {
    status: "ok";
    usedPercent: number;
    resetTimeIso?: string;
    plan?: string;
    paygEnabled?: boolean;
} | {
    status: FailureStatus;
};
export declare function parseMistralVibeQuota(text: string): MistralVibeQuotaResult;
export declare function resolveVibePython(params: {
    workspaceRoot: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
}): Promise<string | null>;
export declare function runVibeQuota(python: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<MistralVibeQuotaResult>;
export declare function queryMistralVibeQuota(params: {
    workspaceRoot: string;
    requestTimeoutMs: number;
}): Promise<MistralVibeQuotaResult>;
export {};
