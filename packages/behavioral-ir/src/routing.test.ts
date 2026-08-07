// The document-label convention: a reader composes a nested document's
// label from the root label and the stack path, and the reachability
// walk recovers the root to scope its nodes. Both directions live in
// one module so they cannot drift, and this pins the round trip.

import { describe, expect, it } from "vitest";

import { nestedDocumentLabel, rootDocumentLabel } from "./routing.js";

describe("document labels", () => {
  it("keeps a root document's label as it is", () => {
    expect(nestedDocumentLabel("cloudformation:root.yaml", [])).toBe(
      "cloudformation:root.yaml",
    );
    expect(rootDocumentLabel("cloudformation:root.yaml")).toBe(
      "cloudformation:root.yaml",
    );
  });

  it("round-trips a nested document back to its root", () => {
    const label = nestedDocumentLabel("cloudformation:root.yaml", [
      "OrdersStack",
      "InnerStack",
    ]);

    expect(label).toBe("cloudformation:root.yaml#OrdersStack/InnerStack");
    expect(rootDocumentLabel(label)).toBe("cloudformation:root.yaml");
  });

  it("gives two documents of one tree the same root and two trees different roots", () => {
    const childA = nestedDocumentLabel("a.yaml", ["StackA"]);
    const childB = nestedDocumentLabel("a.yaml", ["StackB"]);

    expect(rootDocumentLabel(childA)).toBe(rootDocumentLabel(childB));
    expect(rootDocumentLabel(childA)).not.toBe(rootDocumentLabel("b.yaml"));
  });
});
