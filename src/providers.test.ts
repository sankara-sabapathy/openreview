import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readBodyWithIdleTimeout, isRetryableError } from "./providers.js";

function serve(
  handler: (req: unknown, res: { writeHead: Function; write: Function; end: Function; flushHeaders: Function }) => void
): Promise<{ url: string; close: () => void; openSockets: () => number }> {
  return new Promise((resolve) => {
    const server = createServer(handler as never);
    let open = 0;
    server.on("connection", (s) => {
      open++;
      s.on("close", () => open--);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        openSockets: () => open,
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

  it("releases the socket when the trickle guard fires", async () => {
    // The trickle throw skips the idle watchdog's reader.cancel(), which used to
    // hold the connection until the caller's total cap aborted it.
    let open = 0;
    const { url, close, openSockets } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      const timer = setInterval(() => {
        try {
          res.write("x");
        } catch {
          clearInterval(timer);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(timer);
        try {
          res.end();
        } catch {
          // ignore
        }
      }, 5000).unref?.();
    });
    open = openSockets();
    try {
      await assert.rejects(
        readBodyWithIdleTimeout(
          await fetch(url, { headers: { connection: "close" } }),
          3000,
          "t",
          500,
          100000
        ),
        /trickle timeout/
      );
      // The cancel is async and the server-side close event lags it, so poll
      // for eventual release instead of asserting at a fixed instant.
      const deadline = Date.now() + 5000;
      while (openSockets() > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(openSockets(), 0, "trickle path must release the socket");
    } finally {
      close();
    }
  });

  it("lets a slow-but-producing stream through", async () => {
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
        if (n >= 3) {
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
      assert.equal(text.length, 1800);
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
