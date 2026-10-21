// The project's own wrapper for workspace routes. It checks the caller
// and runs the route's handler inside a closure, and hands that closure
// to the logging library's wrapper, which the run cannot read.

import { NextResponse } from "next/server";

import { withAxiomBodyLog } from "../axiom/server";

declare function getSession(): Promise<{ userId: string } | null>;

interface WorkspaceContext {
  req: Request;
  userId: string;
}

export const withWorkspace = (
  handler: (ctx: WorkspaceContext) => Promise<Response>,
) => {
  return withAxiomBodyLog(async (req: Request) => {
    const session = await getSession();
    if (session === null) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return handler({ req, userId: session.userId });
  });
};
