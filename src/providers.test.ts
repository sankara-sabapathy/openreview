import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readBodyWithIdleTimeout, isRetryableError } from "./providers.js";

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
