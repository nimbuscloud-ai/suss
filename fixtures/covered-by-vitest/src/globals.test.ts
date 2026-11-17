import { cancelOrder } from "./orders";

describe("cancel with globals", () => {
  vi.mock("./refunds");

  it("marks the order cancelled", () => {
    expect(cancelOrder("o-1").status).toBe("cancelled");
  });
});
