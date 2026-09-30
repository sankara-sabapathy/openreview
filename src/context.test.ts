import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(path.join(tmpdir(), "or-ctx-"));
  writeFileSync(path.join(dir, "real.ts"), "export function hello() { return 1; }\n");
  try {
    symlinkSync("/etc/hostname", path.join(dir, "evil.ts"));
  } catch {
    // symlink creation may fail on some platforms; test skips that part then
  }

  it("never follows symlinks", () => {
    const r = buildContextBlock({
      repoRoot: dir,
      scopedFiles: ["real.ts", "evil.ts"],
      contextFiles: [],
      includeFullFiles: true,
      maxContextChars: 20000,
      ignore: [],
    });
    assert.ok(!r.block.includes("full file: evil.ts"));
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
  rmSync(dir, { recursive: true, force: true });
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
});
