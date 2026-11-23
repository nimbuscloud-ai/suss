// Helpers that take the HTTP method from their caller and hand it to the
// library. A caller that passes no method sends a GET.

import axios from "axios";

export function send(url: string, method = "GET", body?: string) {
  return fetch(url, { method, body });
}

export function call(url: string, method = "get") {
  return axios({ url, method });
}
