// The browser side of the keys controller. Each call checks for 422,
// and `registerKey` also checks for a 410 the controller never sends.

export async function registerKey(credential: string): Promise<string> {
  const res = await fetch("/keys", { method: "POST", body: credential });
  if (res.status === 422) {
    return "rejected";
  }
  if (res.status === 410) {
    return "retired";
  }
  return "saved";
}

export async function renameKey(id: string, nickname: string): Promise<string> {
  const res = await fetch(`/keys/${id}`, { method: "PATCH", body: nickname });
  if (res.status === 422) {
    return "rejected";
  }
  return "saved";
}
