import { cancelOrder } from "./orders";

function test(title: string, body: () => void) {
  body();
}

test("is the file's own function, not the runner's", () => {
  cancelOrder("o-1");
});
