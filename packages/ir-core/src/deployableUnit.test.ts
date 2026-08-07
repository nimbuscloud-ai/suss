import { describe, expect, it } from "vitest";

import { ecsContainerInstanceName } from "./deployableUnit.js";

describe("ecsContainerInstanceName", () => {
  it("composes the task definition and container name the way runtime-config and the ALB flow reader both write", () => {
    expect(ecsContainerInstanceName("OrdersTaskDefinition", "orders-app")).toBe(
      "OrdersTaskDefinition/orders-app",
    );
  });

  it("keeps two containers on one task definition distinct", () => {
    const first = ecsContainerInstanceName(
      "OrdersTaskDefinition",
      "orders-app",
    );
    const second = ecsContainerInstanceName("OrdersTaskDefinition", "sidecar");
    expect(first).not.toBe(second);
  });
});
