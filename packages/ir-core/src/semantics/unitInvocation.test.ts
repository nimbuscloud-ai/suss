/**
 * How a deployed unit keys, and what a caller has to spell to reach it.
 * The identity is the platform plus the name, so a call written as an
 * ARN and a template that knows the function by logical id only meet
 * once somebody reduces the ARN, which `resourceNameIn` does.
 */

import { describe, expect, it } from "vitest";

import { boundaryKey, canPair, displayLabel } from "../boundaryKey.js";
import { resourceNameIn } from "../boundarySpelling.js";
import { unitInvocationBinding } from "../index.js";

import type { BoundaryBinding } from "../index.js";

const unit = (instanceName: string | null): BoundaryBinding =>
  unitInvocationBinding({
    recognition: "aws-lambda",
    deploymentTarget: "lambda",
    instanceName,
  });

describe("a unit-invocation boundary", () => {
  it("keys on the platform and the name, so two clouds' Workers differ", () => {
    expect(boundaryKey(unit("Worker"))).toBe("unit:lambda Worker");
    expect(
      boundaryKey(
        unitInvocationBinding({
          recognition: "test",
          deploymentTarget: "worker",
          instanceName: "Worker",
        }),
      ),
    ).toBe("unit:worker Worker");
  });

  it("pairs both sides of one function by that key", () => {
    expect(boundaryKey(unit("ReportBuilder"))).toBe(
      boundaryKey(
        unitInvocationBinding({
          recognition: "@suss/framework-aws-lambda",
          deploymentTarget: "lambda",
          instanceName: "ReportBuilder",
        }),
      ),
    );
  });

  it("has no key and pairs with nothing when the call names no unit", () => {
    expect(boundaryKey(unit(null))).toBeNull();
    expect(canPair(unit(null))).toBe(false);
    expect(displayLabel(unit(null))).toBe("unit:lambda (named at runtime)");
  });
});

describe("resourceNameIn", () => {
  it("takes the function out of a Lambda ARN", () => {
    expect(
      resourceNameIn("arn:aws:lambda:us-east-1:123456789012:function:worker"),
    ).toBe("worker");
  });

  it("drops the alias or version a qualified ARN ends with", () => {
    expect(
      resourceNameIn(
        "arn:aws:lambda:us-east-1:123456789012:function:worker:live",
      ),
    ).toBe("worker");
  });

  it("reads the same function from two accounts as one name", () => {
    const dev = resourceNameIn(
      "arn:aws:lambda:us-east-1:111111111111:function:worker",
    );
    const prod = resourceNameIn(
      "arn:aws:lambda:eu-west-1:222222222222:function:worker",
    );
    expect(dev).toBe(prod);
  });

  it("takes the function out of a GCP resource id", () => {
    expect(
      resourceNameIn("projects/p/locations/europe-west1/functions/f"),
    ).toBe("f");
  });

  it("leaves a bare name and an ordinary path alone", () => {
    expect(resourceNameIn("ReportBuilder")).toBe("ReportBuilder");
    expect(resourceNameIn("src/handlers/worker.ts")).toBe(
      "src/handlers/worker.ts",
    );
  });
});
