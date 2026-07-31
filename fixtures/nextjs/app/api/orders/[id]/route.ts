// A route handler in the app directory. The file's place in the tree
// says it serves /api/orders/{id}, and each export says which method.

import { NextResponse } from "next/server";

declare const db: {
  findOrder(id: string): Promise<{ id: string; total: number } | null>;
  cancelOrder(id: string): Promise<void>;
};

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const order = await db.findOrder(params.id);

  if (!order) {
    return NextResponse.json({ error: "no such order" }, { status: 404 });
  }

  return NextResponse.json({ order });
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const order = await db.findOrder(params.id);

  if (!order) {
    return NextResponse.json({ error: "no such order" }, { status: 404 });
  }

  await db.cancelOrder(params.id);

  return NextResponse.json({ cancelled: true }, { status: 202 });
}
