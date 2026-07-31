// The collection alongside it, which answers /api/orders.

import { NextResponse } from "next/server";

declare const db: {
  listOrders(): Promise<Array<{ id: string }>>;
};

export async function GET() {
  const orders = await db.listOrders();
  return NextResponse.json({ orders });
}

export async function POST(request: Request) {
  const body = await request.text();

  if (body.length === 0) {
    return new Response("empty order", { status: 400 });
  }

  return new Response(body, { status: 201 });
}
