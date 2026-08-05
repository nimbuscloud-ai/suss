// What the reader answers today for the ALB fixture: both compute
// units come through, the routing in front of them does not. The
// fixture's README asks the question the routing work has to answer;
// when that lands, the second test here fails and gets promoted to
// assert the paths instead.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { cloudFormationFileToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const fixture = path.resolve(
  __dirname,
  "../../../../fixtures/aws-alb/template.yaml",
);

function summariesFromFixture(): BehavioralSummary[] {
  return cloudFormationFileToSummaries(fixture);
}

describe("the ALB flow template", () => {
  it("finds the compute unit behind each target group", () => {
    const units = summariesFromFixture().map((s) => ({
      instanceName: s.identity.deployableUnit?.instanceName,
      deploymentTarget: s.identity.deployableUnit?.deploymentTarget,
      codeScope: s.metadata?.codeScope,
    }));

    expect(units).toEqual(
      expect.arrayContaining([
        {
          instanceName: "OrdersTaskDefinition/orders-app",
          deploymentTarget: "ecs-task",
          codeScope: { kind: "codeUri", path: "src/orders-app" },
        },
        {
          instanceName: "HealthFunction",
          deploymentTarget: "lambda",
          codeScope: { kind: "codeUri", path: "src/health" },
        },
      ]),
    );
  });

  it("says nothing yet about which unit serves each listener path", () => {
    // The listener rules route /api/orders/* to the ECS service and
    // /api/health to the Lambda, and no summary mentions either path.
    // This is the gap the fixture exists to close.
    const everything = JSON.stringify(summariesFromFixture());

    expect(everything).not.toContain("/api/orders");
    expect(everything).not.toContain("/api/health");
  });
});
