/**
 * The request layer a generated client puts between a service method
 * and axios.
 *
 * A config object goes through two of the project's own functions
 * before anything reaches the library, and each verb is written on an
 * object literal rather than as a named function, so nothing here
 * states a path or a method of its own.
 */

import axios from "axios";

const instance = axios.create();

export interface Opts {
  baseUrl?: string;
  url: string;
  path?: Record<string, string | number>;
  query?: Record<string, string>;
  method?: string;
  body?: unknown;
}

function getUrl(opts: Opts): string {
  return (opts.baseUrl ?? "") + opts.url;
}

function request(opts: Opts) {
  const url = getUrl(opts);
  return instance({ ...opts, url });
}

export const client = {
  get: (o: Opts) => request({ ...o, method: "GET" }),
  post: (o: Opts) => request({ ...o, method: "POST" }),
  delete: (o: Opts) => request({ ...o, method: "DELETE" }),
};
