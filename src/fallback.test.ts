import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runAgent,
  runAgentWithFallback,
  modelChain,
  shouldFallBack,
  isModelLevelError,
  isAuthError,
  parseRetryAfter,
  retryAfterNote,
  retryBackoffMs,
  AgentFailedError,
  ChainFailedError,
  type AgentResult,
} from "./providers.js";
import { parseConfig } from "./config.js";
import { describeFallback, summarizeUsage } from "./main.js";
import { renderStickyBody } from "./github.js";

// Issue #101: free models come and go; a fallback chain keeps reviews running.

const cfg = parseConfig({
  version: 1,
  providers: {
    oc: {
      model: "first-free",
      kind: "openai",
      base_url: "http://127.0.0.1:1/v1",
      retries: 2,
      extra_body: { reasoning_effort: "low" },
      fallback_models: ["second", { model: "third", extra_body: { max_tokens: 99 }, json_mode: false }],
    },
    plain: { model: "only", kind: "openai", base_url: "http://127.0.0.1:1/v1" },
  },
  reviews: [{ id: "r", main: { provider: "oc", instructions: "i" } }],
});
const keys = { anthropicApiKey: "", openaiApiKey: "k", opencodeApiKey: "", opencodeBaseUrl: "", githubToken: "" };
const base = {
  agentName: "a",
  providerName: "oc",
  provider: cfg.providers.oc,
  instructions: "i",
  diff: "d",
  lang: "en",
  keys,
  maxDiffChars: 100,
  sessionId: "s",
};

const withFetch = async <T>(impl: (url: any, init: any) => Promise<Response>, fn: () => Promise<T>): Promise<T> => {
  const real = globalThis.fetch;
  globalThis.fetch = impl as any;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};
const chat = (content: string, usage: any = { prompt_tokens: 10, completion_tokens: 5 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
const modelOf = (init: any) => JSON.parse(init.body).model as string;

describe("modelChain (issue #101)", () => {
  it("keeps transport and key, overrides only what a step sets", () => {
    const chain = modelChain(cfg.providers.oc);
    assert.deepEqual(chain.map((p) => p.model), ["first-free", "second", "third"]);
    assert.ok(chain.every((p) => p.base_url === "http://127.0.0.1:1/v1" && !("fallback_models" in p)));
    assert.deepEqual(chain[1].extra_body, { reasoning_effort: "low" });
    assert.equal(chain[1].json_mode, true);
    assert.deepEqual(chain[2].extra_body, { max_tokens: 99 });
    assert.equal(chain[2].json_mode, false);
    assert.equal(chain[2].retries, 2);
  });

  it("is a single model when no fallback is configured", () => {
    assert.deepEqual(modelChain(cfg.providers.plain).map((p) => p.model), ["only"]);
  });
});

describe("error classification (issue #101)", () => {
  it("treats retired / unknown / out-of-quota models as model-level", () => {
    for (const m of [
      'llm https://opencode.ai/zen/go/v1 502: {"error":{"message":"Upstream request failed: Model is unavailable"}}',
      "llm x 404: model_not_found",
      "llm x 400: Unknown model: cat-jam-free",
      "llm x 402: Payment Required",
      "llm x 429: insufficient_quota",
      "llm x 403: monthly usage limit reached for this subscription",
      "anthropic 404: model: claude-x does not exist",
    ])
      assert.ok(isModelLevelError(m), m);
    for (const m of ["llm x 500: boom", "llm x 401: unauthorized", "timeout after 420s", "llm x 400: bad request"])
      assert.ok(!isModelLevelError(m), m);
  });

  it("falls back on model-level and lasting transient errors, never on auth or budget", () => {
    assert.ok(shouldFallBack("llm x 502: Model is unavailable"));
    assert.ok(shouldFallBack("llm x 500: boom"));
    assert.ok(shouldFallBack("idle timeout after 90s"));
    // Usage-limit wording wins over the 403 it arrives with: another model may be in plan.
    assert.ok(shouldFallBack("llm x 403: usage limit reached"));
    assert.ok(isAuthError("llm x 401: unauthorized"));
    assert.ok(!shouldFallBack("llm x 401: unauthorized"));
    assert.ok(!shouldFallBack("llm x 403: forbidden"));
    assert.ok(!shouldFallBack("llm x 400: bad request"));
    assert.ok(!shouldFallBack(""));
  });
});

describe("Retry-After", () => {
  it("parses seconds and HTTP dates, ignores junk", () => {
    assert.equal(parseRetryAfter("12", 0), 12);
    assert.equal(parseRetryAfter(new Date(30_000).toUTCString(), 0), 30);
    assert.equal(parseRetryAfter(new Date(0).toUTCString(), 10_000), 0);
    assert.equal(parseRetryAfter("soon", 0), null);
    assert.equal(parseRetryAfter(null, 0), null);
  });

  it("is noted only on 429/503", () => {
    const h = (v: string | null) => ({ get: () => v });
    assert.equal(retryAfterNote({ status: 429, headers: h("7") }), " (retry-after 7s)");
    assert.equal(retryAfterNote({ status: 503, headers: h("3") }), " (retry-after 3s)");
    assert.equal(retryAfterNote({ status: 500, headers: h("7") }), "");
    assert.equal(retryAfterNote({ status: 429, headers: h(null) }), "");
  });

  it("raises the backoff to the provider's wait, capped at 60s", () => {
    assert.equal(retryBackoffMs("llm x 500: boom", 2), 4000);
    assert.equal(retryBackoffMs("llm x 429 (retry-after 9s): slow down", 1), 9000);
    assert.equal(retryBackoffMs("llm x 429 (retry-after 1s): slow down", 3), 6000);
    assert.equal(retryBackoffMs("llm x 429 (retry-after 3600s): slow down", 1), 60_000);
  });

  it("keeps the 429 retryable and visible in the error", async () => {
    let n = 0;
    const r = await withFetch(async () => {
      n++;
      return n === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : chat('{"findings":[]}');
    }, () => runAgent({ ...base, provider: cfg.providers.plain }));
    assert.equal(r.attempts, 2);
  });
});

describe("runAgentWithFallback (issue #101)", () => {
  it("is plain runAgent when nothing fails", async () => {
    const seen: string[] = [];
    const r = await withFetch(async (_u, init) => {
      seen.push(modelOf(init));
      return chat('{"findings":[]}');
    }, () => runAgentWithFallback(base));
    assert.deepEqual(seen, ["first-free"]);
    assert.equal(r.model, "first-free");
    assert.equal(r.legs.length, 1);
    assert.equal(describeFallback(r.legs), undefined);
  });

  it("moves on at once from an unavailable model, without spending its retries", async () => {
    const seen: string[] = [];
    const r = await withFetch(async (_u, init) => {
      const m = modelOf(init);
      seen.push(m);
      if (m === "first-free")
        return new Response('{"error":{"message":"Upstream request failed: Model is unavailable"}}', { status: 502 });
      return chat('{"findings":[{"file":"a.ts","line":1,"severity":"high","category":"bug","comment":"x"}]}');
    }, () => runAgentWithFallback(base));
    assert.deepEqual(seen, ["first-free", "second"]);
    assert.equal(r.model, "second");
    assert.equal(r.findings[0].model, "second");
    assert.deepEqual(r.legs.map((l) => l.model), ["first-free", "second"]);
    assert.match(describeFallback(r.legs)!, /^first-free → second \(Upstream request failed: Model is unavailable\)$/);
  });

  it("without a fallback, a 'model unavailable' 5xx is still retried as before", async () => {
    let n = 0;
    const err = await withFetch(async () => {
      n++;
      return new Response("Model is unavailable", { status: 502 });
    }, () => runAgentWithFallback({ ...base, provider: cfg.providers.plain }).then(() => null, (e) => e));
    assert.equal(n, 3);
    assert.ok(err instanceof AgentFailedError);
    assert.ok(!(err instanceof ChainFailedError));
  });

  it("hands over after a transient error outlasts the retries, and walks the whole chain", async () => {
    const seen: string[] = [];
    const r = await withFetch(async (_u, init) => {
      const m = modelOf(init);
      seen.push(m);
      if (m === "first-free") return new Response("boom", { status: 500 });
      if (m === "second") return new Response("llm 404: model_not_found", { status: 404 });
      return chat('{"findings":[]}');
    }, () => runAgentWithFallback(base));
    assert.deepEqual(seen, ["first-free", "first-free", "first-free", "second", "third"]);
    assert.equal(r.model, "third");
    assert.deepEqual(r.legs.map((l) => l.attempts), [3, 1, 1]);
  });

  it("stops on auth errors: the key is shared", async () => {
    const seen: string[] = [];
    const err = await withFetch(async (_u, init) => {
      seen.push(modelOf(init));
      return new Response("unauthorized", { status: 401 });
    }, () => runAgentWithFallback(base).then(() => null, (e) => e));
    assert.deepEqual(seen, ["first-free"]);
    assert.ok(err instanceof ChainFailedError);
    assert.deepEqual(err.legs.map((l: { model: string }) => l.model), ["first-free"]);
  });

  it("reports every model's spend when the whole chain fails", async () => {
    const err = await withFetch(
      async () => new Response("Model is unavailable", { status: 502 }),
      () => runAgentWithFallback(base).then(() => null, (e) => e)
    );
    assert.ok(err instanceof ChainFailedError);
    assert.deepEqual(err.legs.map((l: { model: string }) => l.model), ["first-free", "second", "third"]);
    // The last model has nothing to hand over to, so it keeps its retries.
    assert.deepEqual(err.legs.map((l: { attempts: number }) => l.attempts), [1, 1, 3]);
    assert.equal(err.attempts, 5);
    assert.match(err.message, /models tried: first-free → second → third/);
  });

  it("does not start the next model once the run budget is gone", async () => {
    const calls: string[] = [];
    const fake = (async (o: Parameters<typeof runAgent>[0]) => {
      calls.push(o.provider.model);
      throw new AgentFailedError("x", 1, null, 0, 0, 0, "llm x 502: Model is unavailable");
    }) as typeof runAgent;
    const err = await runAgentWithFallback({ ...base, deadlineAt: Date.now() - 1 }, fake).then(() => null, (e) => e);
    assert.deepEqual(calls, ["first-free"]);
    assert.ok(err instanceof ChainFailedError);
  });

  it("returns a result that came back, even an unparseable one, without falling back", async () => {
    const calls: string[] = [];
    const fake = (async (o: Parameters<typeof runAgent>[0]) => {
      calls.push(o.provider.model);
      return { findings: [], usage: null, seconds: 0, attempts: 1, startedAt: 0, endedAt: 0, outcome: "unparseable" } as AgentResult;
    }) as typeof runAgent;
    const r = await runAgentWithFallback(base, fake);
    assert.deepEqual(calls, ["first-free"]);
    assert.equal(r.outcome, "unparseable");
  });

  it("tells runAgent to fail fast only while another model follows", async () => {
    const flags: (boolean | undefined)[] = [];
    const fake = (async (o: Parameters<typeof runAgent>[0]) => {
      flags.push(o.failFastOnModelError);
      throw new AgentFailedError("x", 1, null, 0, 0, 0, "llm x 502: Model is unavailable");
    }) as typeof runAgent;
    await runAgentWithFallback(base, fake).catch(() => null);
    assert.deepEqual(flags, [true, true, false]);
  });
});

describe("fallback visibility (issue #101)", () => {
  it("lists every model used in the Models footer", () => {
    const { modelsLine } = summarizeUsage([
      { agent: "a", model: "first-free", usage: { in: 0, out: 0 }, seconds: 1, attempts: 1, startedAt: 0, endedAt: 1000 },
      { agent: "a", model: "second", usage: { in: 100, out: 50 }, seconds: 2, attempts: 1, startedAt: 1000, endedAt: 3000 },
    ]);
    assert.match(modelsLine, /first-free/);
    assert.match(modelsLine, /second/);
  });

  it("shows the chain under the provider in the agents table, escaped", () => {
    const body = renderStickyBody({
      verdict: "comment",
      perReview: [],
      findings: [],
      agents: [
        { review: "r", agent: "a", provider: "oc", outcome: "ok", seconds: 1, fallback: "m1 → m2 (bad | <b>x</b>)" },
      ],
    } as any);
    assert.match(body, /\| oc<br><sub>fallback: m1 → m2 \(bad \\\| &lt;b&gt;x&lt;\/b&gt;\)<\/sub> \|/);
  });
});

describe("fallback_models config (issue #101)", () => {
  it("accepts bare ids and objects, on entries and models overrides", () => {
    const c = parseConfig({
      version: 1,
      providers: {
        p: { model: "a", fallback_models: ["b"], models: { f: { model: "x", fallback_models: [{ model: "y" }] } } },
      },
      reviews: [{ id: "r", main: { provider: "p.f", instructions: "i" } }],
    });
    assert.deepEqual(c.providers.p.fallback_models, ["b"]);
    assert.deepEqual(c.providers.p.models.f.fallback_models, [{ model: "y" }]);
  });

  it("rejects an empty model id and chains longer than 5", () => {
    const mk = (fb: unknown) => () =>
      parseConfig({ version: 1, providers: { p: { model: "a", fallback_models: fb } }, reviews: [{ id: "r", main: { provider: "p", instructions: "i" } }] });
    assert.throws(mk([""]));
    assert.throws(mk(["1", "2", "3", "4", "5", "6"]));
  });
});
