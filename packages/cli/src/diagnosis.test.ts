import { describe, expect, it } from "vitest";

import { renderDiagnosis } from "./diagnosis.js";

describe("renderDiagnosis", () => {
  it("renders problem, cause, and a pastable command in that order", () => {
    const lines = renderDiagnosis({
      problem: "No discovery pack is loaded.",
      cause: "aws-sqs labels calls inside boundaries.",
      fix: {
        command: "suss extract -f express -f aws-sqs",
        note: "see --help",
      },
    });
    expect(lines).toEqual([
      "  No discovery pack is loaded.",
      "  aws-sqs labels calls inside boundaries.",
      "  Try: suss extract -f express -f aws-sqs  (see --help)",
    ]);
  });

  it("renders advice bare and leaves out absent parts", () => {
    const lines = renderDiagnosis({
      problem: "That tsconfig matched no source files.",
      fix: { advice: "Check its include patterns." },
    });
    expect(lines).toEqual([
      "  That tsconfig matched no source files.",
      "  Check its include patterns.",
    ]);
  });
});
