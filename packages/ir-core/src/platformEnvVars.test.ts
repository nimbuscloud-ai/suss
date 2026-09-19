// Two readers describe the same Lambda, so a variable one of them
// knows about and the other does not would be an error in one and not
// the other. These pin what every reader of a target gets.

import { describe, expect, it } from "vitest";

import { DeployableUnitSchema } from "./deployableUnit.js";
import { PLATFORM_INJECTED_ENV_VARS } from "./platformEnvVars.js";

describe("PLATFORM_INJECTED_ENV_VARS", () => {
  it("answers for every target a deployable unit can name", () => {
    for (const target of DeployableUnitSchema.shape.deploymentTarget.options) {
      expect(PLATFORM_INJECTED_ENV_VARS[target]).toBeInstanceOf(Array);
    }
  });

  it("gives a Lambda the variables its runtime reserves", () => {
    expect(PLATFORM_INJECTED_ENV_VARS.lambda).toContain("AWS_REGION");
    expect(PLATFORM_INJECTED_ENV_VARS.lambda).toContain("_HANDLER");
  });

  it("gives an ECS task what the agent sets and no Lambda name", () => {
    expect(PLATFORM_INJECTED_ENV_VARS["ecs-task"]).toContain(
      "ECS_CONTAINER_METADATA_URI_V4",
    );
    expect(PLATFORM_INJECTED_ENV_VARS["ecs-task"]).not.toContain("_HANDLER");
  });

  it("leaves a bare container and a Worker empty, since what runs them decides", () => {
    expect(PLATFORM_INJECTED_ENV_VARS.container).toEqual([]);
    expect(PLATFORM_INJECTED_ENV_VARS.worker).toEqual([]);
  });

  it("gives a Kubernetes pod what the kubelet sets", () => {
    expect(PLATFORM_INJECTED_ENV_VARS["k8s-deployment"]).toContain(
      "KUBERNETES_SERVICE_HOST",
    );
  });
});
