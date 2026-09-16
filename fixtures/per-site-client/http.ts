// The one axios instance the two clients below send their requests
// through.

import axios from "axios";

export const http = axios.create({
  headers: { Accept: "application/json" },
});
