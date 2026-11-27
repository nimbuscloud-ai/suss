import { NextResponse } from "next/server";

// Renamed from `summary`, and the order panel still calls the old name.
export async function GET(
  _request: Request,
  context: { params: { id: string } },
) {
  return NextResponse.json({ id: context.params.id, total: 42 });
}
