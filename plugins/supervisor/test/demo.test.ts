/**
 * The 409 story from the design, played through every hook with the
 * suss this repository builds: an edit adds a 409 to POST /orders, the
 * edit's hook blocks on the client that does not handle it, the client
 * is fixed, and the stop report lists the change on both sides.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { playOrders409 } from "../demo/orders409.mjs";

type Played = ReturnType<typeof playOrders409>;

let played: Played;

beforeAll(() => {
  played = playOrders409();
});

function step(index: number) {
  const found = played.steps[index];
  if (found === undefined) {
    throw new Error(`the demo has no step ${index}`);
  }
  return found;
}

describe("the 409 story", () => {
  it("runs every hook and exits 0 each time", () => {
    expect(played.steps.map((s) => s.hook)).toEqual([
      "session-start",
      "prompt",
      "after-edit",
      "after-edit",
      "stop",
      "session-end",
    ]);
    expect(played.steps.every((s) => s.status === 0)).toBe(true);
  });

  it("says nothing at session start or with the prompt", () => {
    expect(step(0).stdout).toBe("");
    expect(step(1).stdout).toBe("");
  });

  it("blocks the edit that adds the 409 with the client that falls through", () => {
    const output = step(2).output;

    expect(output?.decision).toBe("block");
    const reason = String(output?.reason);
    expect(reason).toContain(
      "suss: this edit changed POST /orders and introduced a finding to deal with before moving on.",
    );
    expect(reason).toContain("[WARNING] unhandledProviderCase at POST /orders");
    expect(reason).toContain(
      "Provider produces status 409 but no consumer branch handles it",
    );
    expect(reason).toContain(
      "consumer: web/orders/submitOrder.ts::submitOrder",
    );
    expect(reason).toMatch(
      /provider: \{ transitionId: "post:response:409:[0-9a-f]{7}" \}/,
    );
  });

  it("tells the agent the client fix resolved it, without blocking", () => {
    expect(step(3).output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "suss: this edit changed POST /orders and resolved unhandledProviderCase at POST /orders.",
      },
    });
  });

  it("reports the 409 and the client's new branch when the agent stops", () => {
    const output = step(4).output;

    expect(output?.decision).toBeUndefined();
    const report = String(output?.systemMessage);
    expect(report).toContain("suss: what changed since the session started.");
    expect(report).toContain(
      "~ serves POST /orders  src/orders/create.ts::post",
    );
    expect(report).toContain("+ responds 409 { error }");
    expect(report).toContain(
      "~ calls POST /orders  web/orders/submitOrder.ts::submitOrder",
    );
    expect(report).toContain(
      "+ throw Error  when  !(fetch().status === 201) && fetch().status === 409",
    );
    expect(report).not.toContain("New findings");
  });

  it("says nothing when the session ends", () => {
    expect(step(5).stdout).toBe("");
  });
});
