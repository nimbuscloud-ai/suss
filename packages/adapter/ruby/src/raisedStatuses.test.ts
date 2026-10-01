import { describe, expect, it } from "vitest";

import { storageBinding } from "@suss/behavioral-ir";

import { controllerActionsPattern } from "./__fixtures__/railsControllerPattern.js";
import {
  raisedStatusBranches,
  raisedTerminal,
  rescuedBy,
} from "./raisedStatuses.js";

import type { Effect } from "@suss/behavioral-ir";
import type { RbStoragePattern } from "./pack.js";

const PATTERN = controllerActionsPattern({
  libraryExceptions: {
    StoreError: { ancestors: ["StandardError"] },
    RecordNotFound: { status: 404, ancestors: ["StoreError", "StandardError"] },
    RecordInvalid: { status: 422, ancestors: ["StoreError", "StandardError"] },
  },
});

/** A handler registered for each of these classes, as the run read them. */
function rescuing(
  names: string[],
  inheritableByUnread = false,
): ReturnType<typeof rescuedBy> {
  return rescuedBy(
    names.map((name) => ({
      classes: [
        { name, ancestors: [], incomplete: false, inheritableByUnread },
      ],
      someUnread: false,
    })),
  );
}

const STORAGE = [
  {
    raises: [
      { exception: "RecordNotFound", methods: ["find", "find_by!"] },
      { exception: "RecordInvalid", methods: ["save!"] },
      { exception: "LockWaitTimeout", methods: ["lock!"] },
    ],
  } as unknown as RbStoragePattern,
];

function storageCall(operation: string): Effect {
  return {
    type: "interaction",
    binding: storageBinding({
      recognition: "store",
      storageSystem: "postgresql",
      scope: "default",
      container: "orders",
    }),
    callee: `Order.${operation}`,
    interaction: {
      class: "storage-access",
      kind: "read",
      fields: [],
      operation,
    },
  };
}

const AT = { start: 1, end: 3 };

function statuses(effects: Effect[], rescued: string[] = []): unknown[] {
  return raisedStatusBranches(
    PATTERN,
    STORAGE,
    effects,
    rescuing(rescued),
    AT,
  ).map((branch) => branch.terminal.statusCode);
}

describe("raisedStatusBranches", () => {
  it("responds with the library's status for each exception a model call in the body raises", () => {
    expect(
      statuses([
        storageCall("find_by!"),
        storageCall("save!"),
        storageCall("where"),
      ]),
    ).toEqual([
      { type: "literal", value: 404 },
      { type: "literal", value: 422 },
    ]);
  });

  it("throws instead of responding when the controller rescues that exception or one it inherits from", () => {
    const thrown = (rescued: string[]) =>
      raisedStatusBranches(
        PATTERN,
        STORAGE,
        [storageCall("find")],
        rescuing(rescued),
        AT,
      ).map((branch) => [branch.terminal.kind, branch.terminal.exceptionType]);
    expect(thrown(["RecordNotFound"])).toEqual([["throw", "RecordNotFound"]]);
    expect(thrown(["StoreError"])).toEqual([["throw", "RecordNotFound"]]);
    expect(thrown(["OtherError"])).toEqual([["response", null]]);
  });

  it("gives the throw the ancestry the pack lists, so composition can match the handler", () => {
    const [branch] = raisedStatusBranches(
      PATTERN,
      STORAGE,
      [storageCall("find")],
      rescuing(["StoreError"]),
      AT,
    );
    expect(branch?.terminal.exceptionAncestry).toEqual({
      ancestors: ["StoreError", "StandardError"],
      incomplete: false,
    });
  });

  it("throws an exception the library sends no status for only when the controller rescues it", () => {
    const kinds = (rescued: Parameters<typeof raisedStatusBranches>[3]) =>
      raisedStatusBranches(
        PATTERN,
        STORAGE,
        [storageCall("lock!")],
        rescued,
        AT,
      ).map((branch) => branch.terminal.kind);
    expect(kinds(rescuing(["LockWaitTimeout"]))).toEqual(["throw"]);
    expect(kinds(rescuing(["StandardError"], true))).toEqual(["throw"]);
    expect(kinds(rescuing(["StoreError"]))).toEqual([]);
    expect(kinds(rescuing([]))).toEqual([]);
  });

  it("counts a handler whose classes the run could not read as rescuing everything", () => {
    const rescued = rescuedBy([{ classes: [], someUnread: true }]);
    expect(
      raisedTerminal(
        PATTERN,
        {
          name: "RecordNotFound",
          ancestors: [],
          incomplete: false,
          inheritableByUnread: false,
        },
        rescued,
        AT,
      ).kind,
    ).toBe("throw");
  });

  it("throws with no class for an exception the source computes", () => {
    const terminal = raisedTerminal(PATTERN, null, rescuing([]), AT);
    expect([terminal.kind, terminal.exceptionType]).toEqual(["throw", null]);
    expect(terminal.exceptionAncestry).toBeUndefined();
  });

  it("adds nothing for a body that makes no raising call", () => {
    expect(statuses([storageCall("find_by")])).toEqual([]);
    expect(statuses([])).toEqual([]);
  });
});
