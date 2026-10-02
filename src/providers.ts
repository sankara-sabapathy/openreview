import type { ProviderConfig, ProviderProtocol } from "./config.js";
import * as core from "@actions/core";
import { logInfo, logWarning, logDebug, redactHeaders } from "./logger.js";

export type ResolvedKeys = {
  anthropicApiKey: string;
  openaiApiKey: string;
  opencodeApiKey: string;
  opencodeBaseUrl: string;
  githubToken: string;
};

export function resolveKeysFromEnv(env: NodeJS.ProcessEnv): ResolvedKeys {
  return {
    anthropicApiKey:
      env["INPUT_ANTHROPIC-API-KEY"] || env["ANTHROPIC_API_KEY"] || "",
    openaiApiKey: env["INPUT_OPENAI-API-KEY"] || env["OPENAI_API_KEY"] || "",
    opencodeApiKey:
      env["INPUT_OPENCODE-API-KEY"] || env["OPENCODE_API_KEY"] || "",
    opencodeBaseUrl:
      env["INPUT_OPENCODE-BASE-URL"] ||
      env["OPENCODE_BASE_URL"] ||
      "https://opencode.ai/zen/go/v1",
    githubToken:
      env["INPUT_GITHUB-TOKEN"] || env["GITHUB_TOKEN"] || env["GH_TOKEN"] || "",
  };
}

export type Finding = {
  file: string;
  line?: number;
  severity: "high" | "medium" | "suggestion";
  category: string;
  comment: string;
  confidence: number; // 0-1
  agent: string;
  provider: string;
};

const SYSTEM_WRAPPER = (lang: string, instructions: string) =>
  `You are a senior code reviewer. Language: ${lang}.\nCustom instructions: ${instructions}\n\nReturn ONLY valid JSON: {"findings":[{"file":string,"line":number|null,"severity":"high|medium|suggestion","category":string,"comment":string,"confidence":0-1}]}. No markdown fences. Be strict on bugs/security, lenient on style. Skip low-confidence nits.`;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n...[truncated]" : s;
}

/** Watchdog failure, typed so callers never match on message text. */
export class BodyWatchdogError extends Error {
  constructor(message: string, readonly kind: "idle" | "trickle") {
    super(message);
    this.name = "BodyWatchdogError";
  }
}

/** Read a response body with two watchdogs (issue #41):
 * - idle: any `idleMs` window without a single byte kills the request;
 * - throughput: any rolling `windowMs` delivering fewer than `minWindowBytes`
 *   kills it (trickling streams that defeat the idle check).
 * Slow-but-producing gateways survive both; dead hangs and trickles die fast.
 * Total cap is enforced separately by the caller's AbortController. Exported
 * for unit tests (feed it a real Response from a local trickle server).
 *
 * `trickleGraceMs` is the second-chance delay after a window trips: a gateway
 * that flushes headers early makes the guard run on the FIRST (and often only)
 * chunk, so a small-but-complete body — `{"findings":[]}` is 16 bytes — trips it
 * too. Completion always wins: we only stay fatal while the stream is still open
 * and still trickling past the grace window. */
export async function readBodyWithIdleTimeout(
  res: Response,
  idleMs: number,
  label: string,
  windowMs = 60000,
  minWindowBytes = 1024,
  trickleGraceMs = Math.min(windowMs, Math.floor(idleMs / 2))
): Promise<string> {
  const body = res.body;
  if (!body) return res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let windowStart = Date.now();
  let windowBytes = 0;
  let trickleSince: number | null = null; // window tripped, awaiting grace
  let idleFired = false;
  const fail = () => {
    // NOTE: cancel() resolves (not rejects) the pending read as done:true,
    // so record the flag and raise the idle error explicitly below.
    idleFired = true;
    cancelReader();
  };
  // cancel() resolves on a healthy stream but REJECTS on an errored one, so it
  // needs a handler on the returned promise — a try/catch around the call is
  // not enough and leaks an unhandled rejection.
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // ignore
    }
  };
  const checkWindow = (now: number) => {
    if (now - windowStart < windowMs) return;
    if (windowBytes >= minWindowBytes) {
      windowStart = now;
      windowBytes = 0;
      trickleSince = null; // healthy window: forgive any earlier trip
      return;
    }
    if (trickleSince === null) {
      trickleSince = now; // first trip: give the stream a grace window to finish
      return;
    }
    if (now - trickleSince >= trickleGraceMs) {
      throw new BodyWatchdogError(
        `${label}: trickle timeout (only ${windowBytes}B in the last ${windowMs / 1000}s, ${received}B total)`,
        "trickle"
      );
    }
  };
  try {
    for (;;) {
      const timer = setTimeout(fail, idleMs);
      let read;
      try {
        read = await reader.read();
      } finally {
        clearTimeout(timer);
      }
      if (idleFired) {
        throw new BodyWatchdogError(
          `${label}: idle timeout (no bytes for ${idleMs / 1000}s, got ${received} so far)`,
          "idle"
        );
      }
      if (read.done) break; // completion beats any pending trickle trip
      received += read.value.byteLength;
      windowBytes += read.value.byteLength;
      checkWindow(Date.now());
      chunks.push(read.value);
    }
  } catch (e) {
    // Release the socket on EVERY error path. The trickle throw never went
    // through the idle watchdog's cancel(), and would otherwise hold the
    // connection until the caller's total cap aborts — up to timeout_s later,
    // once per retry.
    cancelReader();
    if (e instanceof BodyWatchdogError) throw e;
    const err = e as Error | undefined;
    // The caller's total-cap AbortController lands here. Rethrow untouched so
    // it keeps its AbortError name and becomes "timeout after <n>ms" upstream —
    // reporting it as an idle timeout hides the real cause.
    if (err?.name === "AbortError") throw err;
    throw new Error(`${label}: body read failed: ${err?.message ?? String(e)}`);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.toString("utf8");
}

export type Usage = { in: number; out: number } | null;

export type AgentResult = {
  findings: Finding[];
  usage: Usage;
  seconds: number;
};

/** Compact token counts: 12345 -> "12.3k". */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

async function callAnthropic(opts: {
  apiKey: string;
  baseUrl: string;
  endpointPath: string;
  headers: Record<string, string>;
  model: string;
  system: string;
  user: string;
  extraBody: Record<string, unknown>;
  timeoutMs: number;
}): Promise<{ text: string; usage: Usage }> {
  const base = opts.baseUrl.replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${base}${opts.endpointPath}`, {
      method: "POST",
      headers: opts.headers,
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 2000,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        ...opts.extraBody,
      }),
      signal: ctrl.signal,
    });
    // Idle 90s: streaming (slow) responses survive, dead hangs die fast.
    const text = await readBodyWithIdleTimeout(res, 90000, "anthropic");
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${text}`);
    const j = JSON.parse(text) as any;
    const out = (j.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    const u = j.usage ?? {};
    const usage: Usage =
      typeof u.input_tokens === "number" || typeof u.output_tokens === "number"
        ? { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0 }
        : null;
    return { text: out, usage };
  } catch (e) {
    if ((e as Error).name === "AbortError")
      throw new Error(`timeout after ${opts.timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatible(opts: {
  apiKey: string;
  baseUrl: string;
  endpointPath: string;
  headers: Record<string, string>;
  model: string;
  system: string;
  user: string;
  jsonMode: boolean;
  extraBody: Record<string, unknown>;
  timeoutMs: number;
}): Promise<{ text: string; usage: Usage }> {
  const base = opts.baseUrl.replace(/\/$/, "");
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: 0.2,
    max_tokens: 2000,
    ...opts.extraBody,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(`${base}${opts.endpointPath}`, {
      method: "POST",
      headers: opts.headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    // Idle 90s: streaming (slow) responses survive, dead hangs die fast.
    const text = await readBodyWithIdleTimeout(res, 90000, "llm");
    if (!res.ok) throw new Error(`llm ${base} ${res.status}: ${text}`);
    const j = JSON.parse(text) as any;
    const u = j.usage ?? {};
    const usage: Usage =
      typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number"
        ? { in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0 }
        : null;
    return { text: j.choices?.[0]?.message?.content ?? '{"findings":[]}', usage };
  } catch (e) {
    if ((e as Error).name === "AbortError")
      throw new Error(`timeout after ${opts.timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function kindDefaults(kind: string | undefined): {
  protocol: ProviderProtocol;
  baseUrl: string;
} {
  switch (kind) {
    case "anthropic":
      return { protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
    case "openai":
      return { protocol: "openai-chat", baseUrl: "https://api.openai.com/v1" };
    case "opencode":
    case "openai-compatible":
      return { protocol: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1" };
    default:
      return { protocol: "openai-chat", baseUrl: "https://api.openai.com/v1" };
  }
}

function legacyKey(kind: string | undefined, keys: ResolvedKeys): string {
  if (kind === "anthropic") return keys.anthropicApiKey;
  if (kind === "openai") return keys.openaiApiKey;
  return keys.opencodeApiKey || keys.openaiApiKey;
}

export type ResolvedProvider = {
  protocol: ProviderProtocol;
  apiKey: string;
  baseUrl: string;
  endpointPath: string;
  headers: Record<string, string>;
  jsonMode: boolean;
  extraBody: Record<string, unknown>;
};

export function resolveProvider(
  provider: ProviderConfig,
  keys: ResolvedKeys,
  env: NodeJS.ProcessEnv,
  sessionId: string
): ResolvedProvider {
  const def = kindDefaults(provider.kind);
  const protocol = provider.protocol ?? def.protocol;
  const baseUrl = provider.base_url ?? def.baseUrl;
  const endpointPath =
    provider.endpoint_path ??
    (protocol === "anthropic-messages" ? "/v1/messages" : "/chat/completions");

  // key_from: "secrets.FOO" | "env.FOO" -> $FOO, else legacy fixed inputs.
  let apiKey = "";
  if (provider.key_from) {
    const name = provider.key_from.replace(/^(secrets|env)\./, "");
    apiKey = env[name] ?? "";
  }
  if (!apiKey) apiKey = legacyKey(provider.kind, keys);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Identify as coding-agent traffic (required by OpenCode Go/Zen, harmless elsewhere).
    "user-agent": "OpenReview/1.0 (github-action)",
    "x-opencode-session": sessionId,
    ...Object.fromEntries(
      Object.entries(provider.headers).map(([k, v]) => [k.toLowerCase(), v])
    ),
  };
  const authHeader = (provider.auth?.header || "Authorization").toLowerCase();
  const authCustomized = provider.auth !== undefined;
  if (protocol === "anthropic-messages" && !authCustomized) {
    // Anthropic default: x-api-key carries the raw key.
    headers["x-api-key"] = apiKey;
  } else {
    // Literal auth: default Bearer Authorization, or whatever the user set
    // (e.g. subscription OAuth under the anthropic protocol, Azure api-key).
    const scheme = provider.auth?.scheme ?? "Bearer";
    headers[authHeader] = scheme ? `${scheme} ${apiKey}` : apiKey;
  }
  if (protocol === "anthropic-messages" && !headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }
  return {
    protocol,
    apiKey,
    baseUrl,
    endpointPath,
    headers,
    jsonMode: provider.json_mode,
    extraBody: provider.extra_body ?? {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retryable: empty responses, timeouts (idle/trickle/total), HTTP 429/5xx,
 * transport failures. Never 4xx auth/shape errors.
 * Note: undici fires its own ~300s body timeout first, so our total cap only
 * matters below that; the idle + trickle guards are the real protection. */
export function isRetryableError(message: string): boolean {
  return /empty (content|response)|timeout after|idle timeout|trickle timeout| 429[:\s]| 5\d\d[:\s]|fetch failed|timeout|ECONNRESET|ENOTFOUND|socket hang up/i.test(
    message
  );
}

export async function runAgent(opts: {
  agentName: string;
  providerName: string;
  provider: ProviderConfig;
  instructions: string;
  diff: string;
  lang: string;
  keys: ResolvedKeys;
  maxDiffChars: number;
  sessionId: string;
  contextBlock?: string;
}): Promise<AgentResult> {
  const system = SYSTEM_WRAPPER(opts.lang, opts.instructions);
  let user = `Review this unified diff (truncated):\n\n${truncate(opts.diff, opts.maxDiffChars)}`;
  if (opts.contextBlock) {
    user += `\n\n${opts.contextBlock}\nGround every finding in the diff above; use <context> only as cross-file evidence (callers, types, contracts). Never flag context-only code.`;
  }
  const rp = resolveProvider(opts.provider, opts.keys, process.env as any, opts.sessionId);
  // missing BYOK key -> skip silently, caller warns
  if (!rp.apiKey) return { findings: [], usage: null, seconds: 0 };

  // Retry budget (issue #30): transient empties/5xx must not silently approve.
  // Per-attempt timeout bounds hung gateway connections (the 9-minute run was
  // a single fetch hanging ~5 min with no timeout).
  const maxAttempts = 1 + Math.min(Math.max(opts.provider.retries ?? 2, 0), 5);
  const timeoutMs = (opts.provider.timeout_s ?? 420) * 1000;
  const started = Date.now();
  let raw = "";
  let usage: Usage = null;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let out;
      if (rp.protocol === "anthropic-messages") {
        out = await callAnthropic({
          apiKey: rp.apiKey,
          baseUrl: rp.baseUrl,
          endpointPath: rp.endpointPath,
          headers: rp.headers,
          model: opts.provider.model,
          system,
          user,
          extraBody: rp.extraBody,
          timeoutMs,
        });
      } else {
        out = await callOpenAICompatible({
          apiKey: rp.apiKey,
          baseUrl: rp.baseUrl,
          endpointPath: rp.endpointPath,
          headers: rp.headers,
          model: opts.provider.model,
          system,
          user,
          jsonMode: rp.jsonMode,
          extraBody: rp.extraBody,
          timeoutMs,
        });
      }
      raw = out.text;
      usage = out.usage;
      if (raw && raw.trim()) break; // success
      lastError = `empty content from ${opts.provider.model}`;
      raw = "";
      usage = null;
    } catch (e) {
      lastError = (e as Error).message;
      raw = "";
      usage = null;
    }
    if (attempt < maxAttempts && isRetryableError(lastError)) {
      logWarning(
        `Agent ${opts.agentName}: attempt ${attempt}/${maxAttempts} failed (${lastError.slice(0, 160)}); retrying`
      );
      await sleep(2000 * attempt);
    } else if (attempt < maxAttempts) {
      break; // non-retryable (auth/shape) — fail fast
    }
  }
  const seconds = (Date.now() - started) / 1000;
  const usageStr = usage
    ? `, ${formatTokens(usage.in)} in / ${formatTokens(usage.out)} out` +
      (usage.out > 0 && seconds > 0 ? `, ${(usage.out / seconds).toFixed(1)} tok/s` : "")
    : "";
  logInfo(`Agent ${opts.agentName}: done in ${seconds.toFixed(1)}s${usageStr}`);
  logDebug(
    `Agent ${opts.agentName}: ${rp.protocol} ${rp.baseUrl}${rp.endpointPath} model=${opts.provider.model} ` +
      `headers=${JSON.stringify(redactHeaders(rp.headers))} ` +
      `prompt=${system.length + user.length} chars (diff ${opts.diff.length}, ctx ${(opts.contextBlock ?? "").length})`
  );
  if (!raw.trim()) {
    // Total failure surfaces into the PR's agent-error block (main.ts catch).
    throw new Error(`Agent ${opts.agentName} failed after ${maxAttempts} attempt(s): ${lastError}`);
  }
  const parsed = extractFindingsJson(raw);
  if (!parsed) {
    logWarning(
      `Agent ${opts.agentName}: could not parse findings JSON; raw head: ${raw.slice(0, 300)}`
    );
    return { findings: [], usage, seconds };
  }
  try {
    const out: Finding[] = [];
    for (const f of parsed.findings ?? []) {
      if (!f?.file || !f?.comment) continue;
      const sev =
        f.severity === "high" || f.severity === "medium" ? f.severity : "suggestion";
      out.push({
        file: String(f.file),
        line: typeof f.line === "number" ? f.line : undefined,
        severity: sev,
        category: String(f.category ?? "general"),
        comment: String(f.comment).slice(0, 1200),
        confidence: typeof f.confidence === "number" ? f.confidence : 0.7,
        agent: opts.agentName,
        provider: opts.providerName,
      });
    }
    return { findings: out, usage, seconds };
  } catch (e) {
    // Validation of individual findings failed — warn, don't silently drop everything.
    logWarning(
      `Agent ${opts.agentName}: findings validation failed (${(e as Error).message}); raw head: ${raw.slice(0, 200)}`
    );
    return { findings: [], usage, seconds };
  }
}

// Parse the findings JSON out of a model response. Tries strict parse first,
// then falls back to the largest {...} substring (models often wrap JSON in
// prose when response_format is ignored). Returns null on total failure.
function extractFindingsJson(raw: string): { findings?: any[] } | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const candidates = [cleaned];
  const greedy = cleaned.match(/\{[\s\S]*\}/);
  if (greedy && greedy[0] !== cleaned) candidates.push(greedy[0]);
  for (const c of candidates) {
    try {
      return JSON.parse(c) as { findings?: any[] };
    } catch {
      // try next candidate
    }
  }
  return null;
}
