/**
 * The fields of the response a Python client reads on each of its paths.
 *
 *   resp = requests.get(f"{BASE}/orders/{order_id}")
 *   order = resp.json()
 *   return order["customer_name"]
 *
 * A read is a subscript or a `.get` with a key the evaluator settles to
 * one string. The walk in `@suss/resolution` says where the value it is
 * read off came from, and `placesInResponse` follows that back through
 * the response's body members and the standard library's decoders to
 * the request. Only a read under one of the pack's body members is a
 * field of the body. Each read goes on the paths `readsOn` puts it on.
 */

import {
  decidesResponse,
  placesInResponse,
  readShapeOf,
  readsOn,
} from "@suss/extractor";

import { children, field, isFunction } from "./ast.js";
import { factSourceOf } from "./factSource.js";
import { sourcesOf } from "./facts/resolve.js";
import { callArguments } from "./facts/values.js";
import { effectSitesIn } from "./paths/effects.js";
import {
  nodeOfResolutionKey,
  resolutionKeyOf,
  stringValueOf,
} from "./values/evaluator.js";

import type { StatusMembers } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawBranch, ReadHop, ResponseReading } from "@suss/extractor";
import type { PyNode } from "./parser.js";

/** What reading a caller's response needs. */
export interface ResponseReads {
  /** The request call whose response the caller has. */
  request: PyNode;
  /** The response's members that give its body, as the pack lists them. */
  bodyMembers: readonly string[];
  /** The members a test on which decides which response a read sees. */
  statusMembers: StatusMembers;
  facts: Database;
}

/** The branches, each with the body fields read on it. */
export function withResponseReads(
  branches: readonly RawBranch[],
  body: PyNode,
  reads: ResponseReads,
): RawBranch[] {
  const found = readsIn(body, reads.facts);
  if (found.length === 0) {
    return [...branches];
  }
  const reading = responseReading(reads);
  const placeOf = placesInResponse(found, reading);
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

/** Every read of a settled key in the body. A nested function's reads are its own. */
function readsIn(body: PyNode, facts: Database): PyNode[] {
  const found: PyNode[] = [];
  const visit = (node: PyNode): void => {
    if (keyRead(node, facts) !== null) {
      found.push(node);
    }
    for (const child of children(node)) {
      if (!isFunction(child)) {
        visit(child);
      }
    }
  };
  visit(body);
  return found;
}

/** `value["key"]` or `value.get("key")`: what is read, and the key. */
function keyRead(
  node: PyNode,
  facts: Database,
): { from: PyNode; key: string } | null {
  if (node.type === "subscript") {
    const from = field(node, "value");
    const index = field(node, "subscript");
    const key = index === null ? null : stringValueOf(index, facts);
    return from === null || key === null ? null : { from, key };
  }
  const callee = node.type === "call" ? field(node, "function") : null;
  if (
    callee?.type !== "attribute" ||
    field(callee, "attribute")?.text !== "get"
  ) {
    return null;
  }
  const from = field(callee, "object");
  const [first] = callArguments(node);
  const key =
    first?.kind === "positional" ? stringValueOf(first.node, facts) : null;
  return from === null || key === null ? null : { from, key };
}

function responseReading(reads: ResponseReads): ResponseReading<PyNode> {
  const { facts } = reads;
  // A name is keyed by its scope, so two reads of it share a key; the
  // position keeps them apart.
  const idOf = (node: PyNode): string =>
    `${resolutionKeyOf(node, facts) ?? node.type}@${node.startIndex}:${node.endIndex}`;
  const requestId = idOf(reads.request);
  return {
    idOf,
    stopsOf: (values, endsAt) => {
      const keyed = values.flatMap((value) => {
        const key = resolutionKeyOf(value, facts);
        return key === null ? [] : [{ value, key }];
      });
      const leaves = sourcesOf(
        facts,
        [...new Set(keyed.map(({ key }) => key))],
        "wantedInputRead",
        (member) => {
          const node = nodeOfResolutionKey(member, facts);
          return node !== null && endsAt(node);
        },
      );
      return new Map(
        keyed.map(({ value, key }) => [
          idOf(value),
          (leaves.get(key) ?? []).map((leaf) => ({
            // A key computed on the way is missing from the path.
            node:
              leaf.computedAt === null
                ? nodeOfResolutionKey(leaf.key, facts)
                : null,
            path: leaf.path,
            written: leaf.end.is === "written",
          })),
        ]),
      );
    },
    isRequest: (node) => idOf(node) === requestId,
    hopOf: (node) => HOPS[node.type]?.(node, reads) ?? null,
    writtenAfter: (stop, read) =>
      stop.tree.rootNode.id === read.tree.rootNode.id &&
      stop.startIndex > read.endIndex,
  };
}

type Hop = (node: PyNode, reads: ResponseReads) => ReadHop<PyNode> | null;

/** What each kind of node is taken from, when it is a value taken from another. */
const HOPS: Record<string, Hop> = {
  subscript: keyHop,
  call: (node, reads) => keyHop(node, reads) ?? callHop(node, reads),
  attribute: (node, reads) => memberHop(node, reads),
  await: unwrapped,
  parenthesized_expression: unwrapped,
};

function keyHop(node: PyNode, reads: ResponseReads): ReadHop<PyNode> | null {
  const read = keyRead(node, reads.facts);
  return read === null ? null : { from: read.from, segments: [read.key] };
}

/** `resp.json()` is the `json` of `resp`, and `json.loads(text)` is `text` decoded. */
function callHop(call: PyNode, reads: ResponseReads): ReadHop<PyNode> | null {
  const callee = field(call, "function");
  if (callee?.type === "attribute") {
    const member = memberHop(callee, reads);
    if (member !== null) {
      return member;
    }
  }
  const key = resolutionKeyOf(call, reads.facts);
  const decoded =
    key === null ? null : factSourceOf(reads.facts).decodedOf?.(key);
  const from =
    decoded === null || decoded === undefined
      ? null
      : nodeOfResolutionKey(decoded.value, reads.facts);
  return from === null ? null : { from, segments: [] };
}

/** `resp.text`, or the `resp.json` a call is made on, when the member is one of the body's. */
function memberHop(
  attribute: PyNode,
  reads: ResponseReads,
): ReadHop<PyNode> | null {
  const from = field(attribute, "object");
  const member = field(attribute, "attribute")?.text;
  return from === null ||
    member === undefined ||
    !reads.bodyMembers.includes(member)
    ? null
    : { from, segments: [member] };
}

function unwrapped(node: PyNode): ReadHop<PyNode> | null {
  const inner = node.namedChild(0);
  return inner === null ? null : { from: inner, segments: [] };
}
