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
 * Catastrophically slow patterns (nested quantifiers like `(a+)+$`, which
 * would stall the synchronous filter) fail the same way.
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
      return;
    }
    if (hasNestedQuantifier(s)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `suppress[${i}] looks catastrophically slow (nested quantifiers): ${s} — ` +
          `simplify the pattern; it runs synchronously against every finding`,
        path: [i],
      });
    }
  });
});

/**
 * True when a regex risks catastrophic backtracking and would stall the
 * synchronous suppress filter (dogfood on #81). Three shapes, checked
 * recursively at every level (new RegExp has already validated the input):
 * 1. nested unbounded quantifiers — `(a+)+$`, `((a+){2})+$`;
 * 2. quantified alternation with overlapping starts — `(a|ab)+$`
 *    (compared case-insensitively, since patterns compile with `i`);
 * 3. adjacent quantified atoms with overlapping starts — `a*a*b*$`.
 * Provably-linear shapes pass: disjoint branches (`(foo|bar)+$`),
 * disjoint sequences (`a+b+$`, `\\s+\\S+$`), bounded repetition
 * (`(ab){2}`, `x{2}`, `(a?)+`). Anything unprovable flags with a message
 * telling the author to simplify.
 */
export function hasCatastrophicPattern(src: string): boolean {
  for (const branch of splitTop(src)) if (checkBranch(branch)) return true;
  return false;
}

/** Alias kept for the earlier name; prefer hasCatastrophicPattern. */
export const hasNestedQuantifier = hasCatastrophicPattern;

type Atom = { first: First; unbounded: boolean; inner?: string; quant?: string };

/** Split on top-level `|` (depth 0), respecting escapes, classes, groups. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let esc = false;
  let inClass = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      cur += ch;
      esc = true;
      continue;
    }
    if (ch === "[") inClass = true;
    if (ch === "]") inClass = false;
    if (!inClass && ch === "(") depth++;
    if (!inClass && ch === ")") depth--;
    if (!inClass && ch === "|" && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** First-char match sets. `any` matches anything; `not` matches anything
 * outside `chars` (for `\\D`-style complements). Chars are case-folded —
 * suppress patterns compile case-insensitively (dogfood on #81). */
type First = { kind: "any" } | { kind: "set"; chars: Set<string> } | { kind: "not"; chars: Set<string> };
const ANY: First = { kind: "any" };

const DIGITS = new Set("0123456789".split(""));
const SPACES = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
const WORDS = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(""));
const fold = (c: string): string => c.toLowerCase();

function union(a: First, b: First): First {
  if (a.kind === "any" || b.kind === "any") return ANY;
  if (a.kind === "set" && b.kind === "set")
    return { kind: "set", chars: new Set([...a.chars, ...b.chars]) };
  if (a.kind === "not" && b.kind === "not") {
    const shared = new Set<string>();
    for (const c of a.chars) if (b.chars.has(c)) shared.add(c);
    return { kind: "not", chars: shared };
  }
  const [not, set] = a.kind === "not" ? [a, b] : [b, a];
  const rest = new Set<string>();
  for (const c of (set as { chars: Set<string> }).chars)
    if (!(not as { chars: Set<string> }).chars.has(c)) rest.add(c);
  return { kind: "set", chars: rest };
}

function intersects(a: First, b: First): boolean {
  if (a.kind === "any" || b.kind === "any") return true;
  if (a.kind === "set" && b.kind === "set") {
    for (const c of a.chars) if (b.chars.has(c)) return true;
    return false;
  }
  if (a.kind === "not" && b.kind === "not") return true;
  const [not, set] = a.kind === "not" ? [a, b] : [b, a];
  for (const c of (set as { chars: Set<string> }).chars)
    if (!(not as { chars: Set<string> }).chars.has(c)) return true;
  return false;
}

/** First-char set of one branch, honouring group modifiers and zero-width. */
function firstOf(branch: string): First | null {
  let i = 0;
  const n = branch.length;
  // Group modifiers: transparent ones (`?:`, `?<name>`) are skipped so the
  // content decides; lookarounds (`?=`, `?!`, `?<=`, `?<!`) match empty and
  // their content must not count as a first char — treat as anything.
  const mod = /^\(\?(?:[:=!]|<[=!]|<[^>]+>)/.exec(branch);
  if (mod) {
    const m = mod[0];
    if (m === "(?:" || (m.startsWith("(?<") && !m.endsWith("=") && !m.endsWith("!"))) i = m.length;
    else return ANY;
  }
  for (;;) {
    if (i >= n) return null;
    const ch = branch[i];
    if (ch === "^" || ch === "$") {
      i++;
      continue;
    }
    if (ch === "\\" && branch[i + 1] === "b") {
      i += 2;
      continue;
    }
    if (ch === ".") return ANY;
    if (ch === "[") {
      let j = i + 1;
      let neg = false;
      if (branch[j] === "^") {
        neg = true;
        j++;
      }
      if (branch[j] === "]") j++;
      const set = new Set<string>();
      while (j < n && branch[j] !== "]") {
        if (branch[j] === "\\") {
          const e = branch[j + 1];
          if (e === undefined) break;
          if (e === "d") for (const c of DIGITS) set.add(c);
          else if (e === "s") for (const c of SPACES) set.add(c);
          else if (e === "w") for (const c of WORDS) set.add(c);
          else if (/[DSW]/.test(e)) return ANY;
          else set.add(fold(e));
          j += 2;
          continue;
        }
        if (branch[j + 1] === "-" && branch[j + 2] !== undefined && branch[j + 2] !== "]") {
          const a = branch.charCodeAt(j);
          const b = branch.charCodeAt(j + 2);
          for (let c = Math.min(a, b); c <= Math.max(a, b); c++) set.add(fold(String.fromCharCode(c)));
          j += 3;
          continue;
        }
        set.add(fold(branch[j]));
        j++;
      }
      if (neg) return { kind: "not", chars: set };
      return { kind: "set", chars: set };
    }
    if (ch === "\\") {
      const e = branch[i + 1];
      if (e === undefined) return null;
      if (e === "d") return { kind: "set", chars: new Set(DIGITS) };
      if (e === "s") return { kind: "set", chars: new Set(SPACES) };
      if (e === "w") return { kind: "set", chars: new Set(WORDS) };
      if (e === "D") return { kind: "not", chars: new Set(DIGITS) };
      if (e === "S") return { kind: "not", chars: new Set(SPACES) };
      if (e === "W") return { kind: "not", chars: new Set(WORDS) };
      return { kind: "set", chars: new Set([fold(e)]) };
    }
    if (ch === "(") {
      const close = matchParen(branch, i);
      const inner = branch.slice(i + 1, close);
      let out: First = { kind: "set", chars: new Set() };
      for (const alt of splitTop(inner)) {
        const f = firstOf(alt);
        if (f === null) return null;
        out = union(out, f);
      }
      return out;
    }
    return { kind: "set", chars: new Set([fold(ch)]) };
  }
}

/** Index of the `)` matching the `(` at pos (nest- and class-aware). */
function matchParen(text: string, pos: number): number {
  let depth = 0;
  let esc = false;
  let inClass = false;
  for (let i = pos; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === "[") inClass = true;
    if (ch === "]") inClass = false;
    if (inClass) continue;
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Quantifier starting at pos: exact `{n}` is bounded, everything else open. */
function readQuant(text: string, pos: number): { unbounded: boolean; end: number; text: string } | null {
  const ch = text[pos];
  if (ch === "+" || ch === "*") return { unbounded: true, end: pos + 1, text: ch };
  if (ch === "?") return { unbounded: false, end: pos + 1, text: ch };
  if (ch === "{") {
    const m = /^\{(\d+)(,(\d*)?)?\}/.exec(text.slice(pos));
    if (!m) return null;
    const openEnded = m[2] !== undefined && (m[3] ?? "") === "";
    return { unbounded: openEnded, end: pos + m[0].length, text: m[0] };
  }
  return null;
}

/** Top-level atoms of a branch; groups carry inner source + quantifier text. */
function tokenize(branch: string): Atom[] {
  const atoms: Atom[] = [];
  let i = 0;
  const n = branch.length;
  const skipZeroWidth = () => {
    for (;;) {
      if (i < n && (branch[i] === "^" || branch[i] === "$")) {
        i++;
        continue;
      }
      if (branch[i] === "\\" && branch[i + 1] === "b") {
        i += 2;
        continue;
      }
      break;
    }
  };
  while (i < n) {
    skipZeroWidth();
    if (i >= n) break;
    if (branch[i] === "|") {
      i++;
      continue; // nested-level pipes belong to splitTop callers
    }
    let first: First;
    let inner: string | undefined;
    if (branch[i] === "(") {
      const close = matchParen(branch, i);
      inner = branch.slice(i + 1, close);
      let out: First = { kind: "set", chars: new Set() };
      for (const alt of splitTop(inner)) {
        const f = firstOf(alt);
        if (f === null) {
          out = ANY;
          break;
        }
        out = union(out, f);
      }
      first = out;
      i = close + 1;
    } else {
      const f = firstOf(branch.slice(i));
      first = f ?? ANY;
      if (branch[i] === "[") {
        let j = i + 1;
        let esc2 = false;
        while (j < n) {
          if (esc2) {
            esc2 = false;
            j++;
            continue;
          }
          if (branch[j] === "\\") {
            esc2 = true;
            j++;
            continue;
          }
          j++;
          if (branch[j - 1] === "]" && j > i + 2) break;
        }
        i = j;
      } else if (branch[i] === "\\") {
        i += 2;
      } else {
        i++;
      }
    }
    const q = readQuant(branch, i);
    atoms.push({ first, unbounded: q !== null && q.unbounded, inner, quant: q?.text });
    if (q) i = q.end;
  }
  return atoms;
}

/** `?`, `*`, `{0}`, `{0,}`, `{0,m}` match empty; `+`, `{n}`, `{n,m}` do not. */
function nullableQuant(q: string | undefined): boolean {
  if (q === undefined) return false;
  if (q === "?" || q === "*") return true;
  const m = /^\{(\d+)(,(\d*)?)?\}$/.exec(q);
  return !!m && m[1] === "0";
}

/** A branch is nullable when every atom can match empty. */
function nullableBranch(branch: string): boolean {
  return tokenize(branch).every(
    (a) => nullableQuant(a.quant) || (a.inner !== undefined && splitTop(a.inner).some(nullableBranch))
  );
}

function checkBranch(branch: string): boolean {
  const atoms = tokenize(branch);
  for (let k = 0; k + 1 < atoms.length; k++) {
    if (atoms[k].unbounded && atoms[k + 1].unbounded && intersects(atoms[k].first, atoms[k + 1].first))
      return true;
  }
  for (const a of atoms) {
    if (a.inner !== undefined && checkGroup(a.inner, a.quant)) return true;
  }
  return false;
}

function checkGroup(inner: string, quant?: string): boolean {
  const branches = splitTop(inner);
  const unbounded = quant !== undefined && isUnboundedQuant(quant);
  if (branches.length > 1 && unbounded) {
    const firsts = branches.map((b) => firstOf(b));
    for (let i = 0; i < firsts.length; i++)
      for (let j = i + 1; j < firsts.length; j++) {
        const [x, y] = [firsts[i], firsts[j]];
        if (x === null || y === null || intersects(x, y)) return true;
      }
    if (branches.some((b) => nullableBranch(b))) return true;
  }
  if (unbounded && subtreeUnbounded(inner)) return true;
  for (const b of branches) if (checkBranch(b)) return true;
  return false;
}

/** `+`, `*`, `{n,}` repeat without bound; `?`, `{n}`, `{n,m}` do not. */
function isUnboundedQuant(q: string): boolean {
  if (q === "+" || q === "*") return true;
  if (q === "?") return false;
  const m = /^\{(\d+)(,(\d*)?)?\}$/.exec(q);
  if (!m) return true; // malformed (validated earlier) — stay conservative
  return m[2] !== undefined && (m[3] ?? "") === "";
}

/** Any unbounded quantifier anywhere in the (sub)pattern. */
function subtreeUnbounded(text: string): boolean {
  for (const branch of splitTop(text)) {
    for (const a of tokenize(branch)) {
      if (a.unbounded) return true;
      if (a.inner !== undefined && subtreeUnbounded(a.inner)) return true;
    }
  }
  return false;
}

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
