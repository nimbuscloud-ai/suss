// Callers of the wrapper, each passing its own method or none at all.
// One reads its URL off a form, so only the method it passes is known.

import { sendWithToken } from "./request";

interface Form {
  getAttribute(name: string): string;
}

export function listOrders() {
  return sendWithToken("/orders");
}

export function createOrder(body: string) {
  return sendWithToken("/orders", { method: "post", body });
}

export function cancelOrder(id: string) {
  return sendWithToken(`/orders/${id}`, { method: "delete" });
}

export function submitOrderForm(form: Form) {
  const action = form.getAttribute("action");
  return sendWithToken(action, { method: "post" });
}
