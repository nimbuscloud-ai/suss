import { it, vi } from "vitest";
import { checkout } from "./checkout";

vi.mock("./orders", () => ({ cancelOrder: () => ({ status: "cancelled" }) }));

it("cancels on a failed checkout", () => {
  checkout("o-1");
});
