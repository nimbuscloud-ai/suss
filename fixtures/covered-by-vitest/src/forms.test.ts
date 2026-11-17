import { describe, it as check, test, vi } from "vitest";
import * as orders from "./orders";
import { refundOrder } from "./refunds";

const IDS = ["o-1", "o-2"];
const TITLE = "refunds";
declare const onCi: boolean;

describe("cancel", () => {
  vi.spyOn(orders, "cancelOrder");

  for (const id of IDS) {
    check(`cancels ${id}`, () => {
      orders.cancelOrder(id);
    });
  }

  IDS.forEach((id) => check(id, () => orders.cancelOrder(id)));

  function cancelsNamed(name: string) {
    check(name, () => orders.cancelOrder(name));
  }
  cancelsNamed("o-3");

  check.each(IDS)("cancels %s by row", (id) => {
    orders.cancelOrder(id);
  });

  describe.skip(TITLE, () => {
    test("refunds the payment", () => {
      refundOrder("o-1");
    });
  });

  test.skipIf(onCi)("runs off CI", { timeout: 10 }, () => {
    orders.cancelOrder("o-4");
  });

  test.todo("cancels a shipped order");
});

test("outside every group", () => {
  vi.doMock("./refunds");
  refundOrder("o-5");
});
