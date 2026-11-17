import { cancelOrder } from "./orders";
export function checkout(id: string) {
  return cancelOrder(id);
}
