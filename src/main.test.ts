import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPooled } from "./main.js";

describe("runPooled (issue #51)", () => {
  it("preserves result order regardless of completion order", async () => {
    const slow = (ms: number, v: number) => () => new Promise<number>((r) => setTimeout(() => r(v), ms));
    const out = await runPooled([slow(30, 1), slow(1, 2), slow(15, 3)], 3);
    assert.deepEqual(out, [1, 2, 3]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const task = () => () =>
      new Promise<number>((r) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          r(1);
        }, 10);
      });
    const thunks = Array.from({ length: 12 }, task);
    const out = await runPooled(thunks, 3);
    assert.equal(out.length, 12);
    assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit of 3`);
    assert.ok(peak > 1, "expected real concurrency, got a serial loop");
  });

  it("a limit of 1 serializes", async () => {
    let inFlight = 0;
    let peak = 0;
    const task = () => () =>
      new Promise<number>((r) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          r(1);
        }, 5);
      });
    await runPooled(Array.from({ length: 5 }, task), 1);
    assert.equal(peak, 1);
  });

  it("limit above the task count is not a problem", async () => {
    const out = await runPooled([() => Promise.resolve("a"), () => Promise.resolve("b")], 99);
    assert.deepEqual(out, ["a", "b"]);
  });

  it("handles an empty task list", async () => {
    assert.deepEqual(await runPooled([], 4), []);
  });
});
