import { describe, expect, it } from "vitest";

import {
  type ByOrigin,
  byOrigin,
  lastValueWins,
  type ReceiverOrigin,
} from "./ops.js";

/** What each kind of origin says about itself, given a prefix. */
const DESCRIBE: ByOrigin<string, [string]> = {
  declaredBy: (origin, prefix) => `${prefix}${origin.importedFrom.join()}`,
  constructed: (origin, prefix) => `${prefix}new ${origin.importedFrom.join()}`,
  anyOf: (origin, prefix) =>
    origin.of.map((one) => byOrigin(DESCRIBE, one, prefix)).join(" | "),
  returnedBy: (origin, prefix) =>
    `${byOrigin(DESCRIBE, origin.on, prefix)}.${origin.method}()`,
  typed: (origin, prefix) => `${prefix}: ${origin.named.join()}`,
  imported: (origin, prefix) => `${prefix}import ${origin.importedFrom.join()}`,
};

describe("dispatching on the kind of origin", () => {
  it("hands each origin to its own entry, with whatever else the table takes", () => {
    const origin: ReceiverOrigin = {
      origin: "anyOf",
      of: [
        { origin: "declaredBy", importedFrom: ["pg"] },
        {
          origin: "returnedBy",
          method: "client",
          on: { origin: "constructed", importedFrom: ["hooks"] },
        },
      ],
    };

    expect(byOrigin(DESCRIBE, origin, "> ")).toBe(
      "> pg | > new hooks.client()",
    );
  });
});

describe("an object's entries once it is built", () => {
  it("keeps a key written again at its first place with the later value, and leaves unsettled keys alone", () => {
    const written = [
      { key: "table", value: "drafts" },
      { key: null, value: "first" },
      { key: "id", value: "1" },
      { key: "table", value: "orders" },
      { key: null, value: "second" },
    ];

    expect(lastValueWins(written)).toEqual([
      { key: "table", value: "orders" },
      { key: null, value: "first" },
      { key: "id", value: "1" },
      { key: null, value: "second" },
    ]);
  });
});
