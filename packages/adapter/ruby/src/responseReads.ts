/**
 * The fields of the response a Ruby client reads on each of its paths.
 *
 *   response = Faraday.get("#{BASE}/orders/#{id}")
 *   order = JSON.parse(response.body)
 *   order["customer_name"]
 *
 * A read is `value[key]`, `value.fetch(key)` or `value.dig(*keys)` with
 * keys the evaluator settles. `placesInResponse` follows the value it is
 * read off back to the request, through the pack's body members and the
 * standard library's decoders. Only a read under one of the body members
 * is a field of the body, and each read goes on the paths `readsOn` puts
 * it on.
 */

import {
  decidesResponse,
  placesInResponse,
  readShapeOf,
  readsOn,
} from "@suss/extractor";

import { children, field, isLambdaArgument, readCallArgs } from "./ast.js";
import { isClaimed } from "./claims.js";
import { decodedIn } from "./encoded.js";
import { sourcesOf } from "./facts/resolve.js";
import { effectSitesIn, methodBody } from "./paths/effects.js";
import {
  nodeOfResolutionKey,
  resolutionKeyOf,
  stringValueOf,
} from "./values/evaluator.js";

import type { StatusMembers } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawBranch, ReadHop, ResponseReading } from "@suss/extractor";
import type { RbNode } from "./parser.js";
import type { ReadableBody } from "./paths/effects.js";

/** What reading a caller's response needs. */
export interface ResponseReads {
  /** The request call whose response the caller has. */
  request: RbNode;
  /** The response's members that give its body, as the pack lists them. */
  bodyMembers: readonly string[];
  /** The members a test on which decides which response a read sees. */
  statusMembers: StatusMembers;
  facts: Database;
}

/** The branches, each with the body fields read on it. */
export function withResponseReads(
  branches: readonly RawBranch[],
  method: RbNode,
  reads: ResponseReads,
): RawBranch[] {
  const body = methodBody(method, reads.facts);
  const found = body === null ? [] : readsIn(body, reads.facts);
  if (found.length === 0) {
    return [...branches];
  }
  const placeOf = placesInResponse(found, responseReading(reads));
  const siteOf = effectSitesIn(body, found);
  const placed = found.flatMap((node) => {
    const place = placeOf(node);
    return place !== null &&
      place.length > 1 &&
      reads.bodyMembers.includes(place[0] ?? "")
      ? [{ place, site: siteOf(node) }]
      : [];
  });
  const decides = decidesResponse(reads.statusMembers);
  return branches.map((branch) => {
    const expectedInput = readShapeOf(
      placed
        .filter((one) => readsOn(one.site, branch, decides))
        .map((one) => one.place),
    );
    return expectedInput === null ? branch : { ...branch, expectedInput };
  });
}

/** Every read of settled keys in the method's own body. */
function readsIn(read: ReadableBody, facts: Database): RbNode[] {
  const found: RbNode[] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      const ownUnit =
        (read.stops.has(child.type) &&
          !isLambdaArgument(child) &&
          read.runsNow?.(child) !== true) ||
        isClaimed(child, read.claimed);
      if (ownUnit) {
        continue;
      }
      if (keyRead(child, facts) !== null) {
        found.push(child);
      }
      visit(child);
    }
  };
  visit(read.body);
  return found;
}

/** The methods that read a hash at keys, and how many leading arguments are keys. */
const KEY_METHODS: Record<string, number> = {
  fetch: 1,
  dig: Number.POSITIVE_INFINITY,
};

/** `value[key]`, `value.fetch(key)` or `value.dig(*keys)`: what is read, and the keys. */
function keyRead(
  node: RbNode,
  facts: Database,
): { from: RbNode; keys: string[] } | null {
  if (node.type === "element_reference") {
    const [from, index, ...rest] = children(node);
    const key =
      index === undefined || rest.length > 0
        ? null
        : stringValueOf(index, facts);
    return from === undefined || key === null ? null : { from, keys: [key] };
  }
  const method = node.type === "call" ? field(node, "method")?.text : undefined;
  const keyCount = method === undefined ? undefined : KEY_METHODS[method];
  const from = field(node, "receiver");
  if (keyCount === undefined || from === null) {
    return null;
  }
  const { positional } = readCallArgs(field(node, "arguments"));
  const written = positional.slice(0, keyCount);
  const keys = written.flatMap((one) => stringValueOf(one, facts) ?? []);
  return keys.length === 0 || keys.length !== written.length
    ? null
    : { from, keys };
}

function responseReading(reads: ResponseReads): ResponseReading<RbNode> {
  const { facts } = reads;
  const idOf = (node: RbNode): string =>
    resolutionKeyOf(node) ?? `${node.type}:${node.startIndex}:${node.endIndex}`;
  const requestId = idOf(reads.request);
  return {
    idOf,
    stopsOf: (values, endsAt) => {
      const keys = new Map<string, RbNode>();
      for (const value of values) {
        const key = resolutionKeyOf(value);
        if (key !== null) {
          keys.set(key, value);
        }
      }
      const leaves = sourcesOf(
        facts,
        [...keys.keys()],
        "wantedInputRead",
        (member) => {
          const node = nodeOfResolutionKey(member, facts);
          return node !== null && endsAt(node);
        },
      );
      return new Map(
        [...keys].map(([key, value]) => [
          idOf(value),
          (leaves.get(key) ?? []).map((leaf) => ({
            // A key computed on the way is missing from the path.
            node:
              leaf.computedAt === null
                ? nodeOfResolutionKey(leaf.key, facts)
                : null,
            path: leaf.path,
          })),
        ]),
      );
    },
    isRequest: (node) => idOf(node) === requestId,
    hopOf: (node) => HOPS[node.type]?.(node, reads) ?? null,
  };
}

type Hop = (node: RbNode, reads: ResponseReads) => ReadHop<RbNode> | null;

/** What each kind of node is taken from, when it is a value taken from another. */
const HOPS: Record<string, Hop> = {
  element_reference: keyHop,
  call: (node, reads) =>
    keyHop(node, reads) ?? memberHop(node, reads) ?? decodeHop(node),
  parenthesized_statements: (node) => {
    const [only, ...rest] = children(node);
    return only === undefined || rest.length > 0
      ? null
      : { from: only, segments: [] };
  },
};

function keyHop(node: RbNode, reads: ResponseReads): ReadHop<RbNode> | null {
  const read = keyRead(node, reads.facts);
  return read === null ? null : { from: read.from, segments: read.keys };
}

/** `response.body` is the `body` of `response`, when `body` is one of the pack's body members. */
function memberHop(call: RbNode, reads: ResponseReads): ReadHop<RbNode> | null {
  const from = field(call, "receiver");
  const member = field(call, "method")?.text;
  return from === null ||
    member === undefined ||
    field(call, "arguments") !== null ||
    !reads.bodyMembers.includes(member)
    ? null
    : { from, segments: [member] };
}

/** `JSON.parse(text)` is `text` decoded. */
function decodeHop(call: RbNode): ReadHop<RbNode> | null {
  const decoded = decodedIn(call);
  return decoded === null ? null : { from: decoded.value, segments: [] };
}
