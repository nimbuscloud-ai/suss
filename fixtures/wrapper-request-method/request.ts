// Two fetch wrappers that never set a method, so each request uses the
// method its caller passes. One fills in empty options when the caller
// passes none, and the other takes its options with a default.

export function sendWithToken(url: string, options?: RequestInit) {
  options = options || {};
  options.headers = { "X-Token": "token" };
  return fetch(url, options).then((response) => response.json());
}

export function sendJson(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { Accept: "application/json" } });
}
