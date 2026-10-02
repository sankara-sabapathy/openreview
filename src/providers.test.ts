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
});
