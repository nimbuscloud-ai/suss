// The client side. Each call checks for a status its route's own
// handler never sends.

export async function checkHealth(): Promise<string> {
  const res = await fetch("/api/health");
  if (res.status === 401) {
    return "signed out";
  }
  return "up";
}

export async function loadStats(): Promise<string> {
  const res = await fetch("/api/admin/stats");
  if (res.status === 410) {
    return "retired";
  }
  return res.text();
}
