import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  readBodyWithIdleTimeout,
  isRetryableError,
  extractAssistantText,
  extractFindingsJson,
  runAgent,
  countsAsReview,
} from "./providers.js";
import { parseConfig } from "./config.js";

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
