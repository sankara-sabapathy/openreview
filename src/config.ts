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
  // Send response_format json_object (openai-chat). Disable for providers that reject it.
  json_mode: z.boolean().default(true),
  // Extra JSON body fields merged into the request (provider-specific params).
  extra_body: z.record(z.unknown()).default({}),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const AgentConfig = z.object({
  name: z.string().optional(),
  provider: z.string(),
  instructions: z.string(),
  max_files: z.number().int().positive().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

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
  max_context_chars: z.number().int().positive().optional(),
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
      on: z.array(z.string()).default(["opened", "synchronize", "ready_for_review"]),
      command: z.string().default("/review"),
      draft: z.boolean().default(false),
      lang: z.string().default("en"),
      ignore: z.array(z.string()).default([]),
      max_diff_chars: z.number().int().positive().default(80000),
      max_context_chars: z.number().int().positive().default(20000),
      include_full_files: z.boolean().default(true),
    })
    .default({}),
  providers: z.record(z.string(), ProviderConfig),
  reviews: z.array(ReviewConfig).min(1),
  global_verdict: z
    .object({
      strategy: z.enum(["any_blocking", "max_severity", "majority"]).default("any_blocking"),
      sticky_comment: z.boolean().default(true),
      fail_check_on_request_changes: z.boolean().default(false),
    })
    .default({}),
});
export type OpenReviewConfig = z.infer<typeof OpenReviewConfig>;

export function parseConfig(raw: unknown): OpenReviewConfig {
  return OpenReviewConfig.parse(raw);
}
