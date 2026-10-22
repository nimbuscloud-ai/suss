// The project's wrapper for admin routes, written out in full: it hands
// back a closure of its own, which refuses a caller who is not an admin.

function isAdmin(req: Request): boolean {
  return req.headers.get("x-role") === "admin";
}

export const withAdmin =
  (handler: (req: Request) => Promise<Response>) =>
  async (req: Request) => {
    if (!isAdmin(req)) {
      return new Response("forbidden", { status: 403 });
    }
    return handler(req);
  };
