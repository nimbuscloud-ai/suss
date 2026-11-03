import { describe, expect, it } from "vitest";

import { configuredSends } from "./configuredSends.js";
import { anyOf, constructedFrom, imported, typed } from "./ops.js";

import type { Chain, MethodMeaning } from "./chain.js";

/** Where a declaration starts, and what it does once it matches. */
function shapeOf(declared: Chain<MethodMeaning>) {
  return {
    origin: declared.links.flatMap((link) =>
      link.asks === "start" ? [link.at.origin] : [],
    ),
    asks: declared.links
      .filter((link) => link.asks !== "start")
      .map((link) => link.asks),
    example: declared.example,
  };
}

describe("the declarations a stated dispatcher becomes", () => {
  it("is a method called on a receiver of the dispatcher's type", () => {
    const declared = configuredSends(
      {
        module: "@acme/async",
        receiver: "CommandDispatcher",
        method: "dispatch",
        subjectArg: 0,
        bodyArg: 1,
      },
      "aws_sqs",
    );

    expect(declared.map((one) => shapeOf(one.declared))).toEqual([
      {
        origin: [
          typed({ from: ["@acme/async"], named: ["CommandDispatcher"] }),
        ],
        asks: ["methods"],
        example: 'CommandDispatcher.dispatch("subject", {})',
      },
    ]);
    expect(declared[0]?.declared.ending).toEqual({
      yields: "messageSend",
      wire: "aws_sqs",
      messages: { each: "theCall" },
      channel: [{ argument: { at: 0 } }],
      body: { argument: { at: 1 } },
      unsettledName: "nothing",
    });
  });

  it("is a bare call, or a method on the module imported whole, for an export", () => {
    const declared = configuredSends(
      {
        module: "@acme/ledger-native",
        export: "publishEntry",
        subject: { at: 0 },
        payload: { at: 1 },
      },
      "eventbridge",
    );

    expect(declared.map((one) => shapeOf(one.declared))).toEqual([
      {
        origin: [
          imported({ from: ["@acme/ledger-native"], named: ["publishEntry"] }),
        ],
        asks: ["calls"],
        example: 'publishEntry("subject", {})',
      },
      {
        origin: [imported({ from: ["@acme/ledger-native"], named: ["*"] })],
        asks: ["methods"],
        example: 'module.publishEntry("subject", {})',
      },
    ]);
  });

  it("is a method on the class or an instance of it, or a bare call from the sub-path, for an export written Class.method", () => {
    const declared = configuredSends(
      {
        module: "@acme/ledger-native",
        export: "Ledger.append",
        subject: { at: 1 },
      },
      "aws_sqs",
    );

    expect(declared.map((one) => shapeOf(one.declared))).toEqual([
      {
        origin: [
          anyOf(
            constructedFrom({
              from: ["@acme/ledger-native"],
              named: ["Ledger"],
            }),
            imported({ from: ["@acme/ledger-native"], named: ["Ledger"] }),
          ),
        ],
        asks: ["methods"],
        example: 'Ledger.append(undefined, "subject")',
      },
      {
        origin: [
          imported({ from: ["@acme/ledger-native/Ledger"], named: ["append"] }),
        ],
        asks: ["calls"],
        example: 'append(undefined, "subject")',
      },
    ]);
    expect(declared[0]?.declared.ending).not.toHaveProperty("body");
  });

  it("reads no export with a longer path", () => {
    expect(
      configuredSends(
        { module: "@acme/ledger", export: "a.b.c", subject: { at: 0 } },
        "aws_sqs",
      ),
    ).toEqual([]);
  });
});
