// The collection alongside it, which answers /api/orders.

import { NextResponse } from "next/server";

declare const db: {
  listOrders(): Promise<Array<{ id: string }>>;
};

export async function GET() {
  const orders = await db.listOrders();
  return NextResponse.json({ orders });
}
