// One caller passes options and the other leaves them out, so the one
// that leaves them out sends with the default.

import { sendJson } from "./request";

export function loadCatalog() {
  return sendJson("/catalog");
}

export function saveCatalog(body: string) {
  return sendJson("/catalog", { method: "put", body });
}
