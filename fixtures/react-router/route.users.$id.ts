// fixtures/react-router/route.users.$id.ts — React Router loader + action
// Exercises: early return guard, dependency call, nested condition, throw

declare const db: {
  findById(id: string): Promise<{ id: string; name: string; active: boolean } | null>;
  updateUser(id: string, data: { name: string }): Promise<void>;
};

declare function json<T>(data: T, init?: { status?: number }): Response;
declare function redirect(url: string, status?: number): Response;

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
