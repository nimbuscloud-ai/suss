// Workspace routes, written through the project's own wrapper.

import { NextResponse } from "next/server";

import { withWorkspace } from "../../../lib/auth/workspace";

declare function listLinks(userId: string): Promise<string[]>;

export const GET = withWorkspace(async ({ userId }) => {
  return NextResponse.json({ links: await listLinks(userId) });
});

export const POST = withWorkspace(async ({ req }) => {
  const body = await req.json();
  if (typeof body.url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 422 });
  }
  return NextResponse.json({ url: body.url }, { status: 201 });
});
