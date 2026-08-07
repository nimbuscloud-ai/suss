// The shared axios instance, built once and imported by every page
// that makes a request. This is the standard frontend layout the
// cross-file resolution exists for.

import axios from "axios";

export const client = axios.create({
  baseURL: "/api",
  headers: { Accept: "application/json" },
});
