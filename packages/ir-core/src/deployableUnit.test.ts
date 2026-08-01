import { describe, expect, it } from "vitest";

import { deployableUnitsAgree } from "./deployableUnit.js";

import type { DeployableUnit } from "./deployableUnit.js";

const lambda = (instanceName: string): DeployableUnit => ({
  deploymentTarget: "lambda",
  instanceName,
});

describe("deployableUnitsAgree", () => {
  it("agrees when both name the same unit", () => {
    expect(
      deployableUnitsAgree(lambda("PostCategorize"), lambda("PostCategorize")),
    ).toBe(true);
  });

  it("disagrees when the instances differ", () => {
    expect(
      deployableUnitsAgree(
        lambda("PostCategorize"),
        lambda("PostNotifyTagged"),
      ),
    ).toBe(false);
  });

  it("disagrees when the deployment targets differ", () => {
    expect(
      deployableUnitsAgree(lambda("Worker"), {
        deploymentTarget: "ecs-task",
        instanceName: "Worker",
      }),
    ).toBe(false);
  });

  it("agrees when either side names nothing", () => {
    expect(deployableUnitsAgree(lambda("Worker"), undefined)).toBe(true);
    expect(deployableUnitsAgree(undefined, lambda("Worker"))).toBe(true);
    expect(deployableUnitsAgree(undefined, undefined)).toBe(true);
  });
});
