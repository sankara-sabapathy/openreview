import { z } from "zod";

export const ProviderKind = z.enum([
  "anthropic",
  "openai",
  "opencode",
  "openai-compatible",
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const ProviderProtocol = z.enum(["openai-chat", "anthropic-messages"]);
export type ProviderProtocol = z.infer<typeof ProviderProtocol>;

export const AuthConfig = z.object({
  // Header carrying the key. "Authorization" (default), "x-api-key", "api-key" (Azure).
  header: z.string().default("Authorization"),
  // Scheme prefix, e.g. "Bearer". "" sends the raw key (Azure api-key style).
  scheme: z.string().default("Bearer"),
});
export type AuthConfig = z.infer<typeof AuthConfig>;

export const ProviderConfig = z.object({
  // Deprecated alias kept for back-compat; maps to protocol + default base_url.
  // Prefer the generic fields below: any provider works with base_url + key_from + model.
  kind: ProviderKind.optional(),
  protocol: ProviderProtocol.optional(),
  model: z.string(),
  base_url: z.string().optional(),
  // Env var holding the key: "secrets.MY_KEY" or "env.MY_KEY" -> $MY_KEY.
  // Falls back to legacy fixed inputs (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENCODE_API_KEY).
  key_from: z.string().optional(),
  // Absent auth means "protocol defaults" (x-api-key for anthropic-messages,
  // Bearer Authorization otherwise). A present auth block is ALWAYS honored
  // literally — this is what allows subscription OAuth (Bearer) under the
  // anthropic protocol. Do not give this a zod default: presence detection
  // is the feature.
  auth: AuthConfig.optional(),
  // Extra headers merged into every request (e.g. custom gateway headers).
  headers: z.record(z.string()).default({}),
  // Endpoint path appended to base_url. Defaults: "/chat/completions" (openai-chat),
  // "/v1/messages" (anthropic-messages).
  endpoint_path: z.string().optional(),
  // Retry budget for transient failures (empty content, 5xx, 429, network).
  // Total failure throws into the PR's agent-error block instead of silent empty.
  retries: z.number().int().min(0).max(5).default(2),
  // Per-attempt HTTP timeout in seconds (default 420, max 600). This is a TOTAL
  // cap; an always-on 90s idle watchdog kills dead hangs fast, and a 60s/1KB
  // trickle guard kills slow-drip streams, while producing responses survive
  // to the cap. Worst case ≈ attempts × timeout_s.
  timeout_s: z.number().int().min(10).max(600).default(420),
  // Send response_format json_object (openai-chat). Disable for providers that reject it.
  json_mode: z.boolean().default(true),
  // Extra JSON body fields merged into the request (provider-specific params).
  extra_body: z.record(z.unknown()).default({}),
  // Named per-model overrides sharing this entry's transport + credential
  // (issue #67): `provider: opencode.flash` merges `{...opencode,
  // ...opencode.models.flash}`. Every field optional with NO defaults, so an
  // entry carrying only `model:` cannot clobber the base's retries/timeout
  // with default values. Overrides replace wholesale per key (shallow merge:
  // an entry `headers` replaces the base `headers`, it does not extend it).
  models: z.record(z.string(), z.object({
    kind: ProviderKind.optional(),
    protocol: ProviderProtocol.optional(),
    model: z.string().optional(),
    base_url: z.string().optional(),
    key_from: z.string().optional(),
    auth: AuthConfig.optional(),
    headers: z.record(z.string()).optional(),
    endpoint_path: z.string().optional(),
    retries: z.number().int().min(0).max(5).optional(),
    timeout_s: z.number().int().min(10).max(600).optional(),
    json_mode: z.boolean().optional(),
    extra_body: z.record(z.unknown()).optional(),
  })).default({}),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const AgentConfig = z.object({
  name: z.string().optional(),
  provider: z.string(),
  instructions: z.string(),
  // NOTE: no max_files (issue #57 removed the reserved-but-unused key).
});
export type AgentConfig = z.infer<typeof AgentConfig>;

/**
 * Decided-item suppression patterns (rebutted findings that must not
 * resurrect). Each entry is a case-insensitive regex tested against
 * "<file> <comment>". Invalid regex fails config parsing naming the entry —
 * a silently non-matching pattern would be the exact bug class this kills.
 */
export const SuppressPatterns = z.array(z.string()).superRefine((arr, ctx) => {
  arr.forEach((s, i) => {
    try {
      new RegExp(s, "i");
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `suppress[${i}] is not a valid regex: ${s}`,
        path: [i],
      });
    }
  });
});

export const VerdictConfig = z.object({
  mode: z.enum(["comment", "approve", "request_changes"]).default("comment"),
  min_severity: z.enum(["suggestion", "medium", "high"]).default("medium"),
  post_inline: z.boolean().default(true),
  deduplicate: z.boolean().default(true),
});
export type VerdictConfig = z.infer<typeof VerdictConfig>;

export const ReviewConfig = z.object({
  id: z.string(),
  if_paths: z.array(z.string()).default(["**"]),
  providers: z.array(z.string()).optional(), // informative; agents pick providers
  strategy: z.enum(["any", "all", "majority"]).default("any"),
  // Extra full files to include as context (globs, repo-relative).
  context_files: z.array(z.string()).default([]),
  // Include full content of changed in-scope files (bounded by max_context_chars).
  include_full_files: z.boolean().optional(),
  // Per-review context budget override (defaults to defaults.max_context_chars).
  max_context_chars: z.number().int().nonnegative().optional(),
  // Noise controls (issue #21): profile preset + explicit overrides (win).
  profile: z.enum(["quiet", "balanced", "assertive"]).optional(),
  min_confidence: z.number().min(0).max(1).optional(),
  max_findings: z.number().int().positive().optional(),
  // Decided items: rebutted patterns suppressed before verdict math (win over
  // defaults.suppress when set).
  suppress: SuppressPatterns.optional(),
  main: AgentConfig,
  subagents: z.array(AgentConfig).default([]),
  verdict: VerdictConfig.default({}),
});
export type ReviewConfig = z.infer<typeof ReviewConfig>;

export const OpenReviewConfig = z.object({
  version: z.literal(1),
  // Optional floor for the running action (see above) + template inheritance.
  // extends entries resolve in order, then this file overlays on top:
  // - "openreview/<name>@<version>" — built-in drop-in from templates/ (version informational)
  // - "github:<owner>/<repo>[/<path>][@sha:<hex>|@<40-hex>]" — community template (immutable pin REQUIRED)
  // - "./relative.yml" — local file next to this config
  requires_action: z.string().optional(),
  extends: z.array(z.string()).default([]),
  defaults: z
    .object({
      // NOTE: event triggers (`on:`) and draft-PR handling live in the
      // WORKFLOW file, not here — the action observes events, never subscribes
      // (issue #57 removed the dead `on`/`draft` keys outright).
      command: z.string().default("/review"),
      lang: z.string().default("en"),
      ignore: z.array(z.string()).default([]),
      max_diff_chars: z.number().int().positive().default(80000),
      // Wall-clock budget for the whole run (issue #51). Once exhausted, no new
      // agent call starts and remaining agents report `budget-exhausted`.
      // Worst case was reviews x agents x (1+retries) x timeout_s (~42 min).
      max_runtime_s: z.number().int().min(30).max(14400).default(1200),
      // Max agents in flight per review. Unbounded fan-out rate-limits small
      // providers and turns retries into a 429 storm.
      max_concurrency: z.number().int().min(1).max(32).default(4),
      max_context_chars: z.number().int().nonnegative().default(20000),
      include_full_files: z.boolean().default(true),
      // Noise defaults (issue #21). Severity stays owned by verdict.min_severity.
      profile: z.enum(["quiet", "balanced", "assertive"]).default("balanced"),
      min_confidence: z.number().min(0).max(1).optional(),
      max_findings: z.number().int().positive().optional(),
      // Suppression defaults; per-review `suppress` wins when set.
      suppress: SuppressPatterns.optional(),
    })
    .default({}),
  providers: z.record(z.string(), ProviderConfig),
  reviews: z.array(ReviewConfig).min(1),
  global_verdict: z
    .object({
      strategy: z.enum(["any_blocking", "max_severity", "majority"]).default("any_blocking"),
      sticky_comment: z.boolean().default(true),
      // update: one mutable status slot (history replaced). append: each run
      // adds a headed section to the same comment (history kept, see #69).
      sticky_comment_mode: z.enum(["update", "append"]).default("update"),
      fail_check_on_request_changes: z.boolean().default(false),
    })
    .default({}),
});
export type OpenReviewConfig = z.infer<typeof OpenReviewConfig>;

export function parseConfig(raw: unknown): OpenReviewConfig {
  return OpenReviewConfig.parse(raw);
}
