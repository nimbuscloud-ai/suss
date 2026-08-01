// React Router loader and action, sitting where the router looks
// for them so the route path comes out of the filename.
// Exercises: early return guard, dependency call, nested condition, throw

declare const db: {
  findById(id: string): Promise<{ id: string; name: string; active: boolean } | null>;
  updateUser(id: string, data: { name: string }): Promise<void>;
};

// Imported the way a route actually gets them. The pack matches these
// names only when they came from the router, since a project's own
// `json` helper is a different function with its own argument order.
declare module "react-router" {
  export function json<T>(data: T, init?: { status?: number }): Response;
  export function redirect(url: string, status?: number): Response;
}
import { json, redirect } from "react-router";

// Loader: GET handler
export async function loader({ params }: { params: { id: string } }) {
  if (!params.id) {
    throw new Response("Not Found", { status: 404 });
  }

  const user = await db.findById(params.id);

  if (!user) {
    return json({ error: "not found" }, { status: 404 });
  }

  if (!user.active) {
    return redirect("/users");
  }

  return json({ user });
}

// Action: POST handler
export async function action({
  params,
  request,
}: { params: { id: string }; request: Request }) {
  const formData = await request.formData();
  const name = formData.get("name") as string | null;

  if (!name) {
    return json({ error: "name required" }, { status: 400 });
  }

  await db.updateUser(params.id, { name });

  return redirect(`/users/${params.id}`);
}
