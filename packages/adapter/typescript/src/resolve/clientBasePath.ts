/**
 * clientBasePath.ts: the path an axios-style client instance sends every
 * request under, read off the config object its factory call was given.
 *
 * A provider's spec states its base in `servers[0].url` and the contract
 * reader puts that in front of each route, so `GET /pet/{petId}` on the
 * provider side is `GET /api/v3/pet/{petId}`. A consumer writes the same
 * information in `axios.create({ baseURL })` instead of in the path, and
 * without folding it in the two sides spell one route two ways and pair
 * nothing. A base the evaluator cannot settle contributes nothing, which
 * leaves the call site's own path alone.
 */

import { Node } from "ts-morph";

import { hasNameHole } from "@suss/behavioral-ir";

import { clientConstructionCall } from "../discovery/clientCall.js";
import { pathFromProperty } from "./routePath.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { CallExpression } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/**
 * The base the instance behind this call sends under, or undefined when
 * the pack declares none, the receiver is the import itself, or nothing
 * settled is written at the option. With a site, the base the
 * construction that site made was given.
 */
export function clientBasePath(
  call: CallExpression,
  match: DiscoveryPattern["match"] | undefined,
  resolution: ResolutionStore | undefined,
  site?: string,
): string | undefined {
  if (match?.type !== "clientCall" || match.basePathOption === undefined) {
    return undefined;
  }
  const receiver = receiverOf(call);
  if (receiver === null) {
    return undefined;
  }
  const construction = clientConstructionCall(receiver, match, resolution);
  const config = construction?.getArguments()[0];
  if (config === undefined) {
    return undefined;
  }
  const base = pathFromProperty(config, match.basePathOption, resolution, site);
  // A base with a hole in it was computed at runtime, and guessing at
  // one would move every path under it to a route nobody serves.
  return base === undefined || hasNameHole(base) ? undefined : base;
}

/**
 * `path` sent under `base`. A base of "/" says nothing about where the
 * request went, so it adds nothing.
 */
export function underBasePath(base: string | undefined, path: string): string;
export function underBasePath(
  base: string | undefined,
  path: string | undefined,
): string | undefined;
export function underBasePath(
  base: string | undefined,
  path: string | undefined,
): string | undefined {
  if (path === undefined || base === undefined) {
    return path;
  }
  const prefix = base.replace(/\/+$/, "");
  if (prefix === "") {
    return path;
  }
  return path.startsWith("/") ? `${prefix}${path}` : `${prefix}/${path}`;
}

/** The object a client call is made on: `api` in `api.get(...)`, `api(...)`. */
function receiverOf(call: CallExpression): Node | null {
  const callee = call.getExpression();
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getExpression();
  }
  return Node.isIdentifier(callee) ? callee : null;
}
