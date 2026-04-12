export function statusHandler(status: string) {
  switch (status) {
    case "active":
      return "ok";
    case "deleted":
      return "gone";
    default:
      return "unknown";
  }
}
