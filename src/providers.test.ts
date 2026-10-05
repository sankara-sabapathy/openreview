import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  readBodyWithIdleTimeout,
  isRetryableError,
  extractAssistantText,
  extractFindingsJson,
  describeResponseShape,
  runAgent,
  AgentFailedError,
  resolveDottedProvider,
  assertProviderRefs,
  countsAsReview,
} from "./providers.js";
import { parseConfig } from "./config.js";
import { hasNestedQuantifier } from "./config.js";

function serve(
  handler: (req: unknown, res: { writeHead: Function; write: Function; end: Function; flushHeaders: Function }) => void
): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(handler as never);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => {
          // Destroy open sockets first: idle/trickle tests leave connections
          // hanging by design, and close() alone waits for them forever.
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

describe("readBodyWithIdleTimeout", () => {
  it("passes a healthy response through untouched", async () => {
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"findings":[]}');
    });
    try {
      const text = await readBodyWithIdleTimeout(await fetch(url, { headers: { connection: "close" } }), 2000, "t", 500, 1024);
      assert.equal(text, '{"findings":[]}');
    } finally {
      close();
    }
  });

  it("kills a fully idle stream", async () => {
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders(); // headers on the wire; body bytes never follow
    });
    try {
      await assert.rejects(
        readBodyWithIdleTimeout(await fetch(url, { headers: { connection: "close" } }), 300, "t", 60000, 1),
        /idle timeout/
      );
    } finally {
      close();
    }
  });

  it("kills a trickling stream that idle alone would allow", async () => {
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => {
        try {
          res.write("x");
        } catch {
          clearInterval(timer);
        }
      }, 150);
      setTimeout(() => {
        clearInterval(timer);
        try {
          res.end();
        } catch {
          // client already gone
        }
      }, 5000).unref?.();
    });
    try {
      // 1 byte/150ms keeps the 800ms idle timer fed, but the 600ms/1KB
      // throughput window must still trip.
      await assert.rejects(
        readBodyWithIdleTimeout(await fetch(url, { headers: { connection: "close" } }), 800, "t", 600, 1024),
        /trickle timeout/
      );
    } finally {
      close();
    }
  });

  it("keeps a small but COMPLETE response (early-flushed headers)", async () => {
    // Regression: a gateway that flushes headers early (proxy/LB/`stream: true`)
    // makes the throughput guard run on the first — and only — chunk, so a
    // small valid payload tripped it and the whole agent died. {"findings":[]}
    // is 16 bytes, so the empty-result path was the worst case. Completion must
    // win: the body is delivered at 700ms (past the 600ms window, well inside
    // the 900ms idle timer) and must survive.
    const body = JSON.stringify({
      findings: [
        {
          file: "src/a.ts",
          line: 12,
          severity: "high",
          category: "bug",
          comment: "Unchecked null deref when opts is undefined.",
          confidence: 0.9,
        },
      ],
    });
    assert.ok(body.length < 1024, "fixture must be under the throughput threshold");
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      setTimeout(() => {
        try {
          res.end(body);
        } catch {
          // ignore
        }
      }, 700);
    });
    try {
      const text = await readBodyWithIdleTimeout(
        await fetch(url, { headers: { connection: "close" } }),
        900,
        "t",
        600,
        1024
      );
      assert.equal(text, body);
    } finally {
      close();
    }
  });

  it("cancels the reader when the trickle guard fires", async () => {
    // The trickle throw used to skip the idle watchdog's reader.cancel(),
    // holding the connection until the caller's total cap aborted it (up to
    // timeout_s later, once per retry). Asserting on a real socket's close
    // event proved timing-dependent on loaded CI runners, so assert the
    // contract directly: the body stream must be cancelled.
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // Keep trickling: the guard is only re-evaluated when a chunk
        // arrives, so a stream that then goes silent is the idle watchdog's
        // job (that is the case the next test covers).
        c.enqueue(new Uint8Array([120]));
        timer = setInterval(() => c.enqueue(new Uint8Array([120])), 15);
      },
      cancel() {
        cancelled = true;
        if (timer) clearInterval(timer);
      },
    });
    const res = new Response(stream, { status: 200 });
    // windowMs 10ms / grace 10ms / threshold 100KB -> trips, then goes fatal.
    await assert.rejects(
      readBodyWithIdleTimeout(res, 1000, "t", 10, 100000, 10),
      /trickle timeout/
    );
    assert.ok(cancelled, "trickle path must cancel the body stream");
  });

  it("cancels the reader when the idle watchdog fires", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* headers, then silence */
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream, { status: 200 });
    await assert.rejects(readBodyWithIdleTimeout(res, 60, "t"), /idle timeout/);
    assert.ok(cancelled, "idle path must cancel the body stream");
  });

  it("lets a slow-but-producing stream through", async () => {
    // 600B/100ms with a 500ms window and a 1KB threshold: every full window
    // clears the threshold, so this also covers the window-RESET branch (7
    // chunks over 700ms > 1 window) — the shorter version of this test used to
    // end before the first window elapsed and never reached it.
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      let n = 0;
      const timer = setInterval(() => {
        n++;
        try {
          res.write("y".repeat(600));
        } catch {
          clearInterval(timer);
          return;
        }
        if (n >= 7) {
          clearInterval(timer);
          try {
            res.end();
          } catch {
            // ignore
          }
        }
      }, 100);
    });
    try {
      const text = await readBodyWithIdleTimeout(await fetch(url, { headers: { connection: "close" } }), 2000, "t", 500, 1024);
      assert.equal(text.length, 4200);
    } finally {
      close();
    }
  });

  it("forgives a tripped window once throughput recovers", async () => {
    // Starve the first window, then produce normally: the trip is recorded, but
    // a healthy window must clear it (trickleSince reset) instead of the stream
    // dying one window later.
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      res.write("a"); // first trip candidate, far below the 1KB threshold
      let n = 0;
      const timer = setInterval(() => {
        n++;
        try {
          res.write("z".repeat(700));
        } catch {
          clearInterval(timer);
          return;
        }
        if (n >= 6) {
          clearInterval(timer);
          try {
            res.end();
          } catch {
            // ignore
          }
        }
      }, 100);
    });
    try {
      const text = await readBodyWithIdleTimeout(await fetch(url, { headers: { connection: "close" } }), 3000, "t", 500, 1024);
      assert.equal(text.length, 1 + 6 * 700);
    } finally {
      close();
    }
  });
});

describe("isRetryableError", () => {
  it("retries trickle/idle/total timeouts, never auth errors", () => {
    assert.ok(isRetryableError("t: trickle timeout (only 12B in the last 60s)"));
    assert.ok(isRetryableError("t: idle timeout (no bytes for 90s)"));
    assert.ok(isRetryableError("timeout after 420000ms"));
    assert.ok(!isRetryableError("llm https://x 401: invalid key"));
  });
  it("keeps the caller's AbortError from the total cap", async () => {
    // The total-cap AbortController aborts mid-read, so reader.read() rejects
    // with an AbortError. It must be rethrown untouched so the caller still maps
    // it to "timeout after <n>ms" (and isRetryableError still retries it)
    // instead of blaming the idle watchdog — the misleading report the review
    // flagged. Injected via an errored stream to keep it deterministic.
    const res = new Response(
      new ReadableStream({
        start(c) {
          c.error(new DOMException("This operation was aborted", "AbortError"));
        },
      }),
      { status: 200 }
    );
    await assert.rejects(readBodyWithIdleTimeout(res, 90000, "t"), (e: Error) => {
      assert.equal(e.name, "AbortError");
      return true;
    });
  });
});

describe("extractAssistantText (issue #26)", () => {
  it("reads content when the model used it", () => {
    assert.equal(
      extractAssistantText({ choices: [{ message: { content: '{"findings":[]}' } }] }),
      '{"findings":[]}'
    );
  });
  it("falls back to reasoning_content, the field reasoning models actually use", () => {
    // DeepSeek V4 flash / GLM answer here and leave content "" -> the old
    // `content ?? '{"findings":[]}'` never fired ("" is not nullish) and the
    // agent was reported as "empty content", then retried 3x for nothing.
    assert.equal(
      extractAssistantText({
        choices: [{ message: { reasoning_content: '{"findings":[{"file":"a.ts"}]}' } }],
      }),
      '{"findings":[{"file":"a.ts"}]}'
    );
  });
  it("does NOT concatenate: content alone wins when present", () => {
    // Concatenating fed the whole thinking trace to extractFindingsJson and lost
    // two complete reviews on a live run (see "prefers content over the
    // reasoning trace" below and the extractFindingsJson regressions).
    assert.equal(
      extractAssistantText({
        choices: [{ message: { reasoning_content: "thinking", content: "answer" } }],
      }),
      "answer"
    );
  });
  it("ignores blank/whitespace-only fields", () => {
    assert.equal(
      extractAssistantText({ choices: [{ message: { reasoning_content: "  ", content: "" } }] }),
      ""
    );
  });
  it("tolerates malformed shapes", () => {
    assert.equal(extractAssistantText({}), "");
    assert.equal(extractAssistantText({ choices: [] }), "");
    assert.equal(extractAssistantText({ choices: [{}] }), "");
    assert.equal(extractAssistantText(null), "");
  });
  it("never returns the old fake-empty JSON", () => {
    // It must be "" so runAgent's "empty content" path (and its 1-retry cap)
    // still works, rather than a plausible-looking empty review.
    assert.equal(extractAssistantText({ choices: [{ message: { content: null } }] }), "");
  });
  it("prefers content over the reasoning trace (live regression)", () => {
    // Concatenating both fed 131k tokens of thinking into the JSON extractor and
    // lost two complete reviews. content wins whenever it has anything.
    assert.equal(
      extractAssistantText({
        choices: [{ message: { reasoning_content: "x".repeat(100000), content: "ANSWER" } }],
      }),
      "ANSWER"
    );
  });
});

describe("extractFindingsJson (issue #54)", () => {
  const J = '{"findings":[{"file":"a.ts","line":1,"severity":"high","comment":"x","confidence":0.9}]}';
  const ok = (r: unknown) => assert.ok(r, "expected findings to be extracted");
  const has = (r: { findings?: unknown[] } | null) => assert.ok(Array.isArray(r?.findings));

  it("parses bare and fenced JSON", () => {
    ok(extractFindingsJson(J));
    has(extractFindingsJson("```json\n" + J + "\n```"));
  });
  it("survives prose after the JSON (the old greedy match died here)", () => {
    ok(extractFindingsJson("Here you go: " + J + " Let me know if you need more."));
  });
  it("survives braces in prose before the JSON", () => {
    ok(extractFindingsJson("Note {see below} -> " + J));
  });
  it("picks the object that actually has findings", () => {
    ok(extractFindingsJson('{"a":1} then ' + J));
    ok(extractFindingsJson(J + ' then {"a":1}'));
  });
  it("recovers from a stray closing brace and an unclosed opening brace", () => {
    ok(extractFindingsJson("}}} oops " + J));
    ok(extractFindingsJson("foo { bar " + J));
  });
  it("handles braces and escaped quotes inside string values", () => {
    has(extractFindingsJson('{"findings":[{"comment":"use {x} and \\"q\\" here"}]}'));
  });
  it("recovers a valid review glued to a 130k-token reasoning trace", () => {
    // The live failure: a thinking monologue quoting code, then the answer.
    const mono =
      "The changed function foo(x) returns {a: 1} so I check if (x) { return {b:2} } instead. ".repeat(1500);
    const r = extractFindingsJson(mono + J + " That is the only issue.");
    has(r);
    assert.equal(r?.findings?.length, 1);
  });
  it("returns null when there is genuinely no JSON", () => {
    assert.equal(extractFindingsJson("no json at all"), null);
    assert.equal(extractFindingsJson("the code is if (x) { return 1 } ok"), null);
    assert.equal(extractFindingsJson(""), null);
  });
  it("keeps a legitimately empty findings array", () => {
    has(extractFindingsJson('{"findings":[]}'));
  });
});

describe("runAgent deadline (issue #51)", () => {
  const cfg = parseConfig({
    version: 1,
    providers: { anthropic: { model: "m", kind: "anthropic", base_url: "http://127.0.0.1:1/v1" } },
    reviews: [{ id: "r", main: { provider: "anthropic", instructions: "i" } }],
  });
  const keys = {
    anthropicApiKey: "k",
    openaiApiKey: "",
    opencodeApiKey: "",
    opencodeBaseUrl: "",
    githubToken: "",
  };
  const base = {
    agentName: "a",
    providerName: "anthropic",
    provider: cfg.providers.anthropic,
    instructions: "i",
    diff: "d",
    lang: "en",
    keys,
    maxDiffChars: 100,
    sessionId: "s",
  };

  it("refuses to start once the budget is gone, and does not vote", async () => {
    const r = await runAgent({ ...base, deadlineAt: Date.now() - 1 });
    assert.equal(r.outcome, "budget-exhausted");
    assert.equal(countsAsReview(r.outcome), false);
    assert.equal(r.findings.length, 0);
  });

  it("clamps a call to the remaining budget instead of hanging", async () => {
    // Unroutable base_url + a huge timeout_s: without clamping the abort would
    // come from ECONNREFUSED, with a real 600s timeout_s it must come from our
    // ~200ms deadline clamp.
    const t0 = Date.now();
    await assert.rejects(
      runAgent({
        ...base,
        provider: { ...cfg.providers.anthropic, timeout_s: 600 },
        deadlineAt: Date.now() + 200,
      })
    );
    const elapsed = Date.now() - t0;
    // Loopback refuses connections immediately either way; the point is that it
    // returns fast and does not run the full attempt budget.
    assert.ok(elapsed < 5000, `took ${elapsed}ms, expected the budget clamp to bound it`);
  });
});

describe("response shape tolerance (any-provider robustness)", () => {
  const J = '{"findings":[{"file":"a.ts"}]}';
  const at = (message: any, extra: any = {}) =>
    extractAssistantText({ choices: [{ message, ...extra }] });

  it("reads array-shaped content blocks", () => {
    // A live run spent 2k output tokens per agent and returned "" for BOTH
    // agents: content arrived as [{type:'text',text}] and the old
    // `typeof === "string"` check dropped it.
    assert.equal(at({ content: [{ type: "text", text: J }] }), J);
    assert.equal(at({ content: [{ type: "text", text: "pre" }, { type: "text", text: J }] }), `pre\n${J}`);
  });
  it("reads object-shaped content", () => {
    assert.equal(at({ content: { text: J } }), J);
    assert.equal(at({ content: { content: J } }), J);
  });
  it("reads completions-style choices[0].text", () => {
    assert.equal(extractAssistantText({ choices: [{ text: J }] }), J);
  });
  it("still prefers real content over a reasoning trace", () => {
    assert.equal(at({ reasoning_content: "long trace", content: J }), J);
  });
  it("falls back through every reasoning field name", () => {
    for (const k of ["reasoning_content", "reasoning", "thinking"]) {
      assert.equal(at({ content: null, [k]: J }), J, `${k} not read`);
    }
  });
  it("stays empty when there is genuinely no text", () => {
    assert.equal(at({ content: 42 }), "");
    assert.equal(at({}), "");
    assert.equal(extractAssistantText({}), "");
  });
  it("cannot loop forever on a self-referential shape", () => {
    const cyclic: any = {};
    cyclic.content = cyclic;
    assert.equal(extractAssistantText({ choices: [{ message: cyclic }] }), "");
  });
});

describe("describeResponseShape (diagnostics)", () => {
  it("names fields and sizes without leaking content", () => {
    const s = describeResponseShape({
      choices: [{ message: { content: [{ type: "text", text: "SECRET-PAYLOAD" }] }, finish_reason: "length" }],
      usage: { completion_tokens: 2000 },
    });
    assert.match(s, /content=array\[1\]/);
    assert.match(s, /finish_reason=length/);
    assert.ok(!s.includes("SECRET-PAYLOAD"), "diagnostics must not echo response content");
  });
  it("describes a response with no choices at all", () => {
    assert.match(describeResponseShape({ error: "boom" }), /no choices/);
  });
});

describe("usage accounting (issue #52)", () => {
  const cfg = parseConfig({
    version: 1,
    providers: { oai: { model: "m", kind: "openai", base_url: "http://127.0.0.1:1/v1" } },
    reviews: [{ id: "r", main: { provider: "oai", instructions: "i" } }],
  });
  const keys = {
    anthropicApiKey: "",
    openaiApiKey: "k",
    opencodeApiKey: "",
    opencodeBaseUrl: "",
    githubToken: "",
  };
  const base = {
    agentName: "a",
    providerName: "oai",
    provider: cfg.providers.oai,
    instructions: "i",
    diff: "d",
    lang: "en",
    keys,
    maxDiffChars: 100,
    sessionId: "s",
  };
  const chat = (content: string, usage: any) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage }));
  const withFetch = async (impl: (url: any, init: any) => Promise<Response>, fn: () => Promise<any>) => {
    const real = globalThis.fetch;
    globalThis.fetch = impl as any;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  };

  it("reports tokens from ALL attempts, not just the last", async () => {
    let n = 0;
    const r = await withFetch(async () => {
      n++;
      // Attempt 1 spends 8k/2k and answers empty (retryable once); attempt 2 succeeds.
      return n === 1
        ? chat("", { prompt_tokens: 8000, completion_tokens: 2000 })
        : chat('{"findings":[]}', { prompt_tokens: 100, completion_tokens: 50 });
    }, () => runAgent(base));
    assert.equal(r.attempts, 2);
    assert.deepEqual(r.usage, { in: 8100, out: 2050 });
    assert.equal(r.outcome, "no-findings");
    assert.ok(r.endedAt >= r.startedAt);
  });

  it("a total failure carries its spend on the error", async () => {
    let n = 0;
    const err = await withFetch(async () => {
      n++;
      if (n === 1) return chat("", { prompt_tokens: 8000, completion_tokens: 2000 });
      return new Response("boom", { status: 500 });
    }, () => runAgent(base).then(() => null, (e) => e));
    assert.ok(err instanceof AgentFailedError);
    assert.equal(err.attempts, 3);
    assert.deepEqual(err.usageTotal, { in: 8000, out: 2000 });
    // Timing must ride along too, or the footer collapses the model's
    // wall-clock window to ~1ms (dogfood on PR #72).
    assert.ok(err.endedAt >= err.startedAt);
    assert.ok(err.seconds >= 0);
  });

  it("a failure with no reported usage carries null, not zero (dogfood on #72)", async () => {
    const err = await withFetch(async () => new Response("boom", { status: 500 }), () =>
      runAgent(base).then(() => null, (e) => e)
    );
    assert.ok(err instanceof AgentFailedError);
    assert.equal(err.usageTotal, null);
  });
});

describe("sticky_comment_mode default (issue #69)", () => {
  it("defaults to update, preserving current behavior", () => {
    const cfg = parseConfig({
      version: 1,
      providers: { oai: { model: "m", kind: "openai" } },
      reviews: [{ id: "r", main: { provider: "oai", instructions: "i" } }],
    });
    assert.equal(cfg.global_verdict.sticky_comment_mode, "update");
    const cfg2 = parseConfig({
      version: 1,
      providers: { oai: { model: "m", kind: "openai" } },
      reviews: [{ id: "r", main: { provider: "oai", instructions: "i" } }],
      global_verdict: { strategy: "any_blocking", sticky_comment_mode: "append" },
    });
    assert.equal(cfg2.global_verdict.sticky_comment_mode, "append");
  });
});

describe("resolveDottedProvider (issue #67)", () => {
  const cfg = parseConfig({
    version: 1,
    providers: {
      opencode: {
        protocol: "openai-chat",
        model: "base-model",
        base_url: "https://opencode.ai/zen/go/v1",
        key_from: "secrets.OPENCODE_API_KEY",
        retries: 5,
        timeout_s: 100,
        models: {
          flash: { model: "flash-model" },
          strict: { model: "strict-model", json_mode: false, timeout_s: 50 },
        },
      },
    },
    reviews: [{ id: "r", main: { provider: "opencode.flash", instructions: "i" } }],
  });
  const providers = cfg.providers;

  it("merges entry over base, keeping untouched base fields", () => {
    const { name, config } = resolveDottedProvider(providers, "opencode.flash");
    assert.equal(name, "opencode.flash");
    assert.equal(config.model, "flash-model");
    assert.equal(config.base_url, "https://opencode.ai/zen/go/v1");
    assert.equal(config.key_from, "secrets.OPENCODE_API_KEY");
    assert.equal(config.retries, 5);
    assert.equal(config.timeout_s, 100);
  });

  it("entry overrides win per key", () => {
    const { config } = resolveDottedProvider(providers, "opencode.strict");
    assert.equal(config.model, "strict-model");
    assert.equal(config.json_mode, false);
    assert.equal(config.timeout_s, 50);
  });

  it("an entry with only overrides keeps the base model (no default clobber)", () => {
    const p = parseConfig({
      version: 1,
      providers: { o: { model: "m", models: { t: { timeout_s: 10 } } } },
      reviews: [{ id: "r", main: { provider: "o.t", instructions: "i" } }],
    });
    const { config } = resolveDottedProvider(p.providers, "o.t");
    assert.equal(config.model, "m");
    assert.equal(config.timeout_s, 10);
    assert.equal(config.retries, 2);
  });

  it("splits on the FIRST dot", () => {
    const p = parseConfig({
      version: 1,
      providers: { o: { model: "m", models: { "a.b": { model: "n" } } } },
      reviews: [{ id: "r", main: { provider: "o.a.b", instructions: "i" } }],
    });
    assert.equal(resolveDottedProvider(p.providers, "o.a.b").config.model, "n");
  });

  it("unknown entry throws naming provider and entry, never falls back", () => {
    assert.throws(() => resolveDottedProvider(providers, "opencode.flah"), /'flah'.*'opencode'/);
  });

  it("unknown base throws naming it", () => {
    assert.throws(() => resolveDottedProvider(providers, "nope.flash"), /'nope'/);
  });

  it("assertProviderRefs fails fast on dotted typos, ignores legacy plains", () => {
    assert.doesNotThrow(() => assertProviderRefs(cfg));
    const bad = parseConfig({
      version: 1,
      providers: { o: { model: "m" } },
      reviews: [{ id: "r", main: { provider: "o.typo", instructions: "i" } }],
    });
    assert.throws(() => assertProviderRefs(bad), /'typo'.*'o'/);
    const legacy = parseConfig({
      version: 1,
      providers: { o: { model: "m" } },
      reviews: [{ id: "r", main: { provider: "ghost", instructions: "i" } }],
    });
    assert.doesNotThrow(() => assertProviderRefs(legacy));
  });
});

describe("suppress patterns validation", () => {
  const base = {
    version: 1,
    providers: { o: { model: "m" } },
    reviews: [{ id: "r", main: { provider: "o", instructions: "i" } }],
  };
  it("rejects an invalid regex naming the entry", () => {
    assert.throws(
      () =>
        parseConfig({
          ...base,
          reviews: [{ id: "r", main: { provider: "o", instructions: "i" }, suppress: ["ok(", "[unclosed"] }],
        }),
      /suppress\[1\] is not a valid regex/
    );
  });
  it("accepts valid patterns at both levels", () => {
    const cfg = parseConfig({
      ...base,
      defaults: { suppress: ["backdate"] },
      reviews: [{ id: "r", main: { provider: "o", instructions: "i" }, suppress: ["compat"] }],
    });
    assert.deepEqual(cfg.defaults.suppress, ["backdate"]);
    assert.deepEqual(cfg.reviews[0].suppress, ["compat"]);
  });
});

describe("hasNestedQuantifier (dogfood on #81)", () => {
  it("rejects the classic catastrophic shapes", () => {
    for (const evil of ["(a+)+$", "([a-z]+)+", "(a|ab)+$", "((a+)+)+", "(a{2,})+"]) {
      assert.equal(hasNestedQuantifier(evil), true, `${evil} should be flagged`);
    }
  });
  it("allows ordinary patterns", () => {
    for (const ok of ["compat-date", "backdate the config", "foo.*bar", "(foo|bar)+", "a+", "x{2}", "x{2,3}", "\\(a+\\)", "(ab){2}"]) {
      assert.equal(hasNestedQuantifier(ok), false, `${ok} should pass`);
    }
  });
  it("rejects evil patterns at config load", () => {
    assert.throws(
      () =>
        parseConfig({
          version: 1,
          providers: { o: { model: "m" } },
          reviews: [{ id: "r", main: { provider: "o", instructions: "i" }, suppress: ["(a+)+$"] }],
        }),
      /catastrophically slow/
    );
  });
});
