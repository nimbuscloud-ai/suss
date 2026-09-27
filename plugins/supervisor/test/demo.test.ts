/**
 * The recorded stories, played through every hook with the suss this
 * repository builds.
 *
 * In the 409 story an edit adds a 409 to POST /orders, the edit's hook
 * blocks on the client that does not handle it, the client is fixed,
 * and the stop report lists the change on both sides. In the cancel
 * story the agent writes a change list first, and the stop checks the
 * work against it. In the environment variable story a Lambda service
 * starts reading a new variable in a helper both functions share.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { playAccountsRegion } from "../demo/accountsRegion.mjs";
import { playCancelOrder } from "../demo/cancelOrder.mjs";
import { playOrders409 } from "../demo/orders409.mjs";

type Played = ReturnType<typeof playOrders409>;

let played: Played;
let cancel: Played;
let region: Played;

beforeAll(() => {
  played = playOrders409();
  cancel = playCancelOrder();
  region = playAccountsRegion();
});

function stepOf(demo: Played, index: number) {
  const found = demo.steps[index];
  if (found === undefined) {
    throw new Error(`the demo has no step ${index}`);
  }
  return found;
}

function step(index: number) {
  return stepOf(played, index);
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

  it("says nothing at session start, and tells the agent where a change list goes", () => {
    expect(step(0).stdout).toBe("");
    const context = step(1).output?.hookSpecificOutput as
      | { additionalContext?: string }
      | undefined;
    expect(context?.additionalContext).toMatch(
      /^suss: if this request will change code, write the change list for it to .*intent\.yaml before your first edit/,
    );
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

describe("the cancel story, with a change list", () => {
  const DONE = [
    "done        + POST /orders/{id}/cancel responds 200, 404  src/orders/cancel.ts::post",
    "            + POST /orders/{id}/cancel writes postgresql:orders [cancelled_at]  src/orders/cancel.ts::post",
    'unchecked   ~ Order.status gains the value "cancelled"',
    "              suss has no boundary spelled Order.status, so it cannot check this entry.",
  ].join("\n");

  it("runs every hook and exits 0 each time", () => {
    expect(cancel.steps.map((s) => s.hook)).toEqual([
      "session-start",
      "prompt",
      "after-edit",
      "after-edit",
      "after-edit",
      "after-edit",
      "stop",
      "after-edit",
      "stop",
      "session-end",
    ]);
    expect(cancel.steps.every((s) => s.status === 0)).toBe(true);
  });

  it("reads nothing again when the agent writes the change list", () => {
    expect(stepOf(cancel, 2).stdout).toBe("");
    expect(stepOf(cancel, 7).stdout).toBe("");
  });

  it("blocks the first stop on the 409 nobody asked for", () => {
    const output = stepOf(cancel, 6).output;

    expect(output?.decision).toBe("block");
    const reason = String(output?.reason);
    expect(reason).toContain(
      "suss: the code and the change list do not agree yet.",
    );
    expect(reason).toContain(
      "2 done, 1 unchecked and 1 boundary changed where nobody asked.",
    );
    expect(reason).toContain(DONE);
    expect(reason).toContain(
      "not asked   serves POST /orders  src/orders/create.ts::post\n              + responds 409 { error }",
    );
  });

  it("passes the next stop once an explained line keeps the 409", () => {
    const output = stepOf(cancel, 8).output;

    expect(output?.decision).toBeUndefined();
    const report = String(output?.systemMessage);
    expect(report).toContain(
      "suss: what changed since the session started, against the change list.\n\n2 done and 1 unchecked.",
    );
    expect(report).toContain(DONE);
    expect(report).toContain(
      "explained   ~ POST /orders responds 409\n              why: a second open order for the same sku was charged twice, so POST /orders refuses it",
    );
    expect(report).not.toContain("not asked");
  });
});

describe("the environment variable story, on a Lambda service with a SAM template", () => {
  function said(index: number): string {
    const output = stepOf(region, index).output;
    const specific = output?.hookSpecificOutput as
      | { additionalContext?: string }
      | undefined;
    return String(
      output?.reason ?? specific?.additionalContext ?? output?.systemMessage,
    );
  }

  it("runs every hook and exits 0 each time", () => {
    expect(region.steps.map((s) => s.hook)).toEqual([
      "session-start",
      "prompt",
      "after-edit",
      "after-edit",
      "after-edit",
      "after-edit",
      "after-edit",
      "after-edit",
      "stop",
      "after-edit",
      "stop",
      "session-end",
    ]);
    expect(region.steps.every((s) => s.status === 0)).toBe(true);
  });

  it("says nothing after an edit that changes only functions inside the project", () => {
    expect(stepOf(region, 3).stdout).toBe("");
  });

  it("names the variable a helper started reading, and the helper, with no internal key or package name", () => {
    const output = stepOf(region, 4).output;

    expect(output?.decision).toBe("block");
    expect(said(4)).toContain(
      "suss: this edit changed runtime-config ACCOUNTS_REGION through getAccountService and introduced 2 findings to deal with before moving on.",
    );
    expect(said(4)).toContain(
      "[ERROR] boundaryFieldUnknown at runtime-config:GetAccountFunction",
    );
    expect(said(4)).toContain(
      "[ERROR] boundaryFieldUnknown at runtime-config:UpdateAccountFunction",
    );
    for (const index of [4, 6, 7]) {
      expect(said(index)).not.toContain("function-call:");
      expect(said(index)).not.toContain("@suss/");
    }
  });

  it("names the function whose template entry now declares the variable", () => {
    expect(stepOf(region, 5).stdout).toBe("");
    expect(said(6)).toBe(
      "suss: this edit changed runtime-config:GetAccountFunction ACCOUNTS_REGION and resolved boundaryFieldUnknown at runtime-config:GetAccountFunction.",
    );
    expect(said(7)).toBe(
      "suss: this edit changed runtime-config:UpdateAccountFunction ACCOUNTS_REGION and resolved boundaryFieldUnknown at runtime-config:UpdateAccountFunction.",
    );
  });

  it("lists what the stop found changed when no entry in the change list can be checked", () => {
    const output = stepOf(region, 8).output;

    expect(output?.decision).toBe("block");
    expect(said(8)).toContain(
      "2 unchecked and 2 boundaries changed where nobody asked.",
    );
    for (const fn of ["GetAccountFunction", "UpdateAccountFunction"]) {
      expect(said(8)).toContain(
        [
          `serves runtime-config:${fn}  cloudformation:template.yaml::${fn}`,
          "              + declares ACCOUNTS_REGION from AccountsRegion",
          `              + reads runtime-config:${fn} ACCOUNTS_REGION  through getAccountService`,
        ].join("\n"),
      );
    }
  });

  it("counts the read done for both functions once the list spells it the way the skill shows", () => {
    const output = stepOf(region, 10).output;

    expect(output?.decision).toBeUndefined();
    expect(said(10)).toContain("1 done and 1 unchecked.");
    expect(said(10)).toContain(
      "done        + reads runtime-config [ACCOUNTS_REGION]  cloudformation:template.yaml::GetAccountFunction, cloudformation:template.yaml::UpdateAccountFunction",
    );
    expect(said(10)).not.toContain("not asked");
  });
});
