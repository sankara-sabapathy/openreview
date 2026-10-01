import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { extractDefinedNames, buildContextBlock } from "./context.js";
import { combineBallots, decideReviewVerdict, matchesAny } from "./reviewer.js";
import { isRetryableError } from "./providers.js";

describe("extractDefinedNames", () => {
  it("finds exported TS symbols", () => {
    const names = extractDefinedNames(
      "export function foo() {}\nexport const bar = 1;\nclass Baz {}\nconst x = 1;"
    );
    assert.ok(names.includes("foo"));
    assert.ok(names.includes("bar"));
    assert.ok(names.includes("Baz"));
  });
  it("finds python/go defs", () => {
    const names = extractDefinedNames("def handler():\n  pass\nclass Model:\n  pass");
    assert.ok(names.includes("handler") && names.includes("Model"));
    assert.ok(extractDefinedNames("func Serve() {}").includes("Serve"));
  });
});

describe("buildContextBlock", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "or-ctx-"));
    writeFileSync(path.join(dir, "real.ts"), "export function hello() { return 1; }\n");
    try {
      symlinkSync("/etc/hostname", path.join(dir, "evil.ts"));
    } catch {
      // symlinks unavailable on some platforms; related tests assert accordingly
    }
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("never follows symlinks", () => {
    const link = path.join(dir, "evil.ts");
    if (!existsSync(link)) return; // symlinks unavailable on this platform
    let targetContent = "";
    try {
      targetContent = readFileSync("/etc/hostname", "utf8").trim();
    } catch {
      // unreadable target; the exclusion assertion below still holds
    }
    const r = buildContextBlock({
      repoRoot: dir,
      scopedFiles: ["real.ts", "evil.ts"],
      contextFiles: [],
      includeFullFiles: true,
      maxContextChars: 20000,
      ignore: [],
    });
    assert.ok(!r.block.includes("full file: evil.ts"));
    if (targetContent) assert.ok(!r.block.includes(targetContent));
  });

  it("never escapes through a symlinked directory", () => {
    const outside = dir + "-outside";
    try {
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(outside, "secret.txt"), "top-secret");
      symlinkSync(outside, path.join(dir, "linkdir"));
    } catch {
      return; // symlinks unavailable on this platform
    }
    try {
      const r = buildContextBlock({
        repoRoot: dir,
        scopedFiles: ["real.ts"],
        contextFiles: ["linkdir/secret.txt"],
        includeFullFiles: false,
        maxContextChars: 20000,
        ignore: [],
      });
      assert.ok(!r.block.includes("top-secret"));
      assert.ok(r.stats.includes("linkdir/secret.txt"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(path.join(dir, "linkdir"), { force: true });
    }
  });

  it("warns on missing explicit context files", () => {
    const r = buildContextBlock({
      repoRoot: dir,
      scopedFiles: ["real.ts"],
      contextFiles: ["nope-missing.ts"],
      includeFullFiles: false,
      maxContextChars: 20000,
      ignore: [],
    });
    assert.ok(r.stats.includes("nope-missing.ts"));
  });

  it("zero budget disables", () => {
    const r = buildContextBlock({
      repoRoot: dir,
      scopedFiles: ["real.ts"],
      contextFiles: [],
      includeFullFiles: true,
      maxContextChars: 0,
      ignore: [],
    });
    assert.equal(r.block, "");
  });

  it("respects budget", () => {
    const r = buildContextBlock({
      repoRoot: dir,
      scopedFiles: ["real.ts"],
      contextFiles: [],
      includeFullFiles: true,
      maxContextChars: 500,
      ignore: [],
    });
    assert.ok(r.block.length <= 700);
  });
});

describe("ballots", () => {
  const v = (fs: { severity: "high" | "medium" | "suggestion" }[]) =>
    decideReviewVerdict("request_changes", "high", fs);
  it("any = most severe, all = unanimous, majority = median", () => {
    assert.equal(combineBallots([v([{ severity: "high" }]), v([])], "any"), "request_changes");
    assert.equal(combineBallots([v([{ severity: "high" }]), v([])], "all"), "approve");
    assert.equal(
      combineBallots([v([{ severity: "high" }]), v([])], "majority"),
      "request_changes"
    );
  });
});

describe("misc", () => {
  it("matchesAny globs", () => {
    assert.ok(matchesAny("src/a.ts", ["src/**"]));
    assert.ok(!matchesAny("src/a.ts", ["test/**"]));
  });
  it("retry classification", () => {
    assert.ok(isRetryableError("empty content from m"));
    assert.ok(isRetryableError("llm https://x 503: down"));
    assert.ok(!isRetryableError("llm https://x 401: bad key"));
  });
  it("formatTokens compacts", async () => {
    const { formatTokens } = await import("./providers.js");
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(12400), "12.4k");
  });
});

describe("logger", () => {
  it("redacts key material from headers", async () => {
    const { redactHeaders } = await import("./logger.js");
    const out = redactHeaders({
      authorization: "Bearer sk-ant-secret",
      "x-api-key": "sk-ant-secret",
      "X-Api-Key": "other-secret",
      "api-key": "azure-secret",
      "content-type": "application/json",
    });
    assert.equal(out["authorization"], "Bearer ***");
    assert.equal(out["x-api-key"], "***");
    assert.equal(out["X-Api-Key"], "***");
    assert.equal(out["api-key"], "***");
    assert.equal(out["content-type"], "application/json");
    assert.ok(!JSON.stringify(out).includes("secret"));
  });
  it("masks every token in multi-token values", async () => {
    const { redactHeaders } = await import("./logger.js");
    const out = redactHeaders({ authorization: "Bearer abc123 extra" });
    assert.equal(out["authorization"], "Bearer ***");
    assert.ok(!out["authorization"].includes("abc123"));
  });
  it("marks unset keys", async () => {
    const { redactHeaders } = await import("./logger.js");
    assert.equal(redactHeaders({ authorization: "" })["authorization"], "(not set)");
  });
});
