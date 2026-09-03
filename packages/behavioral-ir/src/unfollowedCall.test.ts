import { describe, expect, it } from "vitest";

import { unfollowedCallGap, worthRecording } from "./unfollowedCall.js";

import type { UnfollowedReason } from "./unfollowedCall.js";

describe("unfollowed calls", () => {
  it("records the stops that point at code the project owns", () => {
    const recorded: Record<UnfollowedReason, boolean> = {
      noBody: true,
      unsettledValue: true,
      multipleSources: true,
      outsideRun: false,
      noDeclaration: false,
      callerSupplied: false,
      multipleReceivers: true,
    };
    for (const [reason, expected] of Object.entries(recorded)) {
      expect(worthRecording(reason as UnfollowedReason)).toBe(expected);
    }
  });

  it("writes a gap that names the callee and says why the walk stopped", () => {
    const sentences: Record<UnfollowedReason, string> = {
      noBody: "lands on a declaration with no body",
      unsettledValue: "goes through a value this run could not settle",
      multipleSources: "more than one possible source",
      outsideRun: "lands in a package whose source is not in this run",
      noDeclaration: "has no declaration this run could find",
      callerSupplied: "runs the function this unit's caller passed in",
      multipleReceivers: "reads as 3 different values",
    };
    for (const [reason, fragment] of Object.entries(sentences)) {
      const gap = unfollowedCallGap({
        callee: "svc.run",
        reason: reason as UnfollowedReason,
        candidates: 3,
      });
      expect(gap).toMatchObject({
        type: "unfollowedCall",
        callee: "svc.run",
        consequence: "unknown",
      });
      expect(gap.description).toContain("The call to svc.run ");
      expect(gap.description).toContain(fragment);
    }
  });

  it("says several receivers when nobody counted them", () => {
    const gap = unfollowedCallGap({
      callee: "router.use",
      reason: "multipleReceivers",
    });
    expect(gap.description).toContain("several different values");
  });
});
