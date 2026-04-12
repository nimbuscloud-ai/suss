export async function guardedHandler(id: string, user: any) {
  if (!id) return "missing-id";
  if (!user) return "missing-user";
  if (!user.isActive) return "inactive";
  return "success";
}
