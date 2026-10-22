import { describe, expect, it } from "vitest";

import { renderRule } from "../scripts/report.mjs";

describe("renderRule", () => {
  it("keys a rule on a transition", () => {
    expect(
      renderRule({
        kind: "boundaryFieldUnknown",
        boundary: "postgresql:orders",
        consumer: { transitionId: "post:response:201:1402b5d" },
      }),
    ).toEqual([
      "- kind: boundaryFieldUnknown",
      '  boundary: "postgresql:orders"',
      '  consumer: { transitionId: "post:response:201:1402b5d" }',
      "  reason: <why this is intended>",
    ]);
  });

  it("keys a rule on a field when the finding has no transition", () => {
    expect(
      renderRule({
        kind: "boundaryShapeMismatch",
        boundary: "postgresql:attachments",
        consumer: { field: "blobId" },
      }),
    ).toEqual([
      "- kind: boundaryShapeMismatch",
      '  boundary: "postgresql:attachments"',
      '  consumer: { field: "blobId" }',
      "  reason: <why this is intended>",
    ]);
  });
});
