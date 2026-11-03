import { describe, expect, it } from "vitest";

import { type ByOrigin, byOrigin, type ReceiverOrigin } from "./ops.js";

/** What each kind of origin says about itself, given a prefix. */
const DESCRIBE: ByOrigin<string, [string]> = {
  declaredBy: (origin, prefix) => `${prefix}${origin.importedFrom.join()}`,
  constructed: (origin, prefix) => `${prefix}new ${origin.importedFrom.join()}`,
  anyOf: (origin, prefix) =>
    origin.of.map((one) => byOrigin(DESCRIBE, one, prefix)).join(" | "),
  returnedBy: (origin, prefix) =>
    `${byOrigin(DESCRIBE, origin.on, prefix)}.${origin.method}()`,
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
