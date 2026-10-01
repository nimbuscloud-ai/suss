import { describe, expect, it } from "vitest";

import { storageBinding } from "@suss/behavioral-ir";

import { controllerActionsPattern } from "./__fixtures__/railsControllerPattern.js";
import { raisedStatusBranches } from "./raisedStatuses.js";

import type { Effect } from "@suss/behavioral-ir";
import type { RbStoragePattern } from "./pack.js";

const PATTERN = controllerActionsPattern({
  exceptionStatuses: {
    RecordNotFound: { status: 404, ancestors: ["StoreError", "StandardError"] },
    RecordInvalid: { status: 422, ancestors: ["StoreError", "StandardError"] },
  },
});

const STORAGE = [
  {
    raises: [
      { exception: "RecordNotFound", methods: ["find", "find_by!"] },
      { exception: "RecordInvalid", methods: ["save!"] },
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
    new Set(rescued),
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

  it("leaves a status out when the controller rescues that exception or one it inherits from", () => {
    expect(statuses([storageCall("find")], ["RecordNotFound"])).toEqual([]);
    expect(statuses([storageCall("find")], ["StoreError"])).toEqual([]);
    expect(statuses([storageCall("find")], ["OtherError"])).toEqual([
      { type: "literal", value: 404 },
    ]);
  });

  it("adds nothing for a body that makes no raising call", () => {
    expect(statuses([storageCall("find_by")])).toEqual([]);
    expect(statuses([])).toEqual([]);
  });
});
