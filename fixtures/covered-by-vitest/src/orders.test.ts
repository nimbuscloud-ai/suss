import { describe, expect, it, vi } from "vitest";
import { cancelOrder } from "./orders";
import { refundOrder } from "./refunds";

describe("cancel", () => {
  it("marks the order cancelled", () => {
    expect(cancelOrder("o-1").status).toBe("cancelled");
  });

  it("refunds the payment", () => {
    expect(refundOrder("o-1")).toBe(true);
  });

  it.skip("cancels twice without harm", () => {
    cancelOrder("o-1");
    cancelOrder("o-1");
  });
});
