// The directive in single quotes marks the module the same way. An
// export a project helper builds is an action too, here the closure the
// helper returns, since that closure never calls what it was handed.
'use server';

import { cached } from "./lib";

declare const db: {
  ordersFor(customerId: string): Promise<Array<{ id: string }>>;
  revalidate(tag: string): Promise<void>;
};

export const getOrderHistory = cached(async (customerId: string) => {
  return db.ordersFor(customerId);
}, "order-history");

export async function revalidateOrders() {
  await db.revalidate("order-history");
}

export default async function () {
  return db.ordersFor("guest");
}
