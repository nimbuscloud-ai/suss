// An instance whose base URL is only known at runtime. The base is
// not readable statically, so a summary of a call on this client can
// carry the call site's own path and nothing more.

import axios from "axios";

export const dynamicClient = axios.create({
  baseURL: process.env.API_URL,
});
