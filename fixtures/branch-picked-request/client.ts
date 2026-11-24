// Requests whose method or URL a branch before the call picks. Each
// branch that changes the request is a request of its own; the last
// helper's branch changes neither, so it makes one request.

export async function saveSprocket(sprocket: { id?: string; name: string }) {
  const target = sprocket.id
    ? { method: "PATCH", url: `/api/sprockets/${sprocket.id}` }
    : { method: "POST", url: "/api/sprockets" };
  const res = await fetch(target.url, {
    method: target.method,
    body: JSON.stringify(sprocket),
  });
  return res.json();
}

export async function loadGizmo(id?: string) {
  const res = await fetch(id ? `/api/gizmos/${id}` : "/api/gizmos");
  return res.json();
}

export async function toggleWidget(on: boolean) {
  const res = await fetch("/api/widgets/current", {
    method: on ? "PUT" : "DELETE",
  });
  return res.status;
}

export async function fetchReport(period: string) {
  let path: string;
  switch (period) {
    case "day":
      path = "/api/reports/daily";
      break;
    case "week":
    case "fortnight":
      path = "/api/reports/weekly";
      break;
    case "month":
      path = "/api/reports/monthly";
      break;
    case "year":
      path = "/api/reports/yearly";
      break;
    default:
      path = "/api/reports/all";
  }
  const res = await fetch(path);
  return res.json();
}

export async function pingDoohickey(verbose: boolean) {
  const url = verbose ? "/api/doohickeys/ping" : "/api/doohickeys/ping";
  const res = await fetch(url, { method: "POST" });
  return res.status;
}
