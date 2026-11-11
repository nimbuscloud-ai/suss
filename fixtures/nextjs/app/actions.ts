// A file that opens with "use server" makes every function it exports a
// server action, which a client component calls as if it were local.
"use server";

import { createSafeActionClient } from "next-safe-action";
import { z } from "zod";

import { validatedAction } from "./lib";

declare const db: {
  insertOrder(sku: string, count: number): Promise<{ id: string }>;
  cancelOrder(id: string): Promise<void>;
  refundOrder(id: string): Promise<void>;
  updateOrder(id: string, sku: string): Promise<void>;
  deleteOrder(id: string): Promise<void>;
  log(event: string): Promise<void>;
};

export async function createOrder(sku: string, count: number) {
  const order = await db.insertOrder(sku, count);
  await auditLog(`created ${order.id}`);
  return { id: order.id };
}

// The same function under a second name is still one action.
export { createOrder as placeOrder };

// Marked twice, by the file and by its own body, and still one action.
export const cancelOrder = async (id: string) => {
  "use server";
  await db.cancelOrder(id);
  return { cancelled: id };
};

// Not exported, so no client can call it.
async function auditLog(event: string) {
  await db.log(event);
}

export default async function submitOrder(formData: FormData) {
  const sku = String(formData.get("sku"));
  return createOrder(sku, 1);
}

const refundOrder = async (id: string) => {
  await db.refundOrder(id);
  return { refunded: id };
};

export { refundOrder };

const orderUpdate = z.object({ id: z.string(), sku: z.string() });

export const updateOrder = validatedAction(orderUpdate, async (data) => {
  await db.updateOrder(data.id, data.sku);
  return { ok: true };
});

export { archiveOrder } from "./lib";

// A library builds this action, and its body is not in the project.
const actionClient = createSafeActionClient();

export const deleteOrder = actionClient.action(async () => {
  await db.deleteOrder("last");
});

// Neither of these is a function, so neither is an action.
export const ORDER_LABELS = { pending: "Pending", shipped: "Shipped" };

export class OrderStore {
  async save(id: string) {
    return id;
  }
}

// An overloaded function is one action, read at its implementation.
export function quote(sku: string): Promise<number>;
export function quote(sku: string, count: number): Promise<number>;
export async function quote(sku: string, count = 1) {
  return sku.length * count;
}
