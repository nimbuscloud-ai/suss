/**
 * What a mount call serves besides the routers suss mounted: a static
 * file server or a proxy the pack lists, or a value suss could not
 * follow, which may be a router whose routes then sit at the wrong
 * paths. The mount scan asks this about each `use` call it reads, so
 * nothing walks the file a second time. A function written in the
 * project, or a call into a library the pack does not list, is plain
 * middleware and serves nothing of its own.
 */

import { Node } from "ts-morph";

import { nodeId } from "../facts/extract.js";
import { rootIdentifier } from "../resolve/callOps.js";
import { factSourceFor } from "../resolve/factSource.js";
import { functionValueOf, writtenNodeOf } from "./resolveValue.js";

import type { ServingCall } from "@suss/extractor";
import type { CallExpression } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/** A mount call that serves requests beside the routes suss read. */
export interface MountBeside {
  by: "proxy" | "static" | "mount";
  /** The prefix it is mounted at, or null when that did not read. */
  prefix: string | null;
  file: string;
  line: number;
  written: string;
}

export interface BesideMounts {
  servingCalls: readonly ServingCall[];
  found: (mount: MountBeside) => void;
}

/**
 * A mount call whose prefix did not read: one written as a string suss
 * could not settle covers every path, and one with no prefix at all is
 * middleware, which serves something only when it is a serving call.
 */
export function noteUnprefixedMount(
  call: CallExpression,
  prefixArg: Node | undefined,
  args: readonly Node[],
  beside: BesideMounts,
  resolution: ResolutionStore | undefined,
): void {
  if (prefixArg !== undefined && writtenAsString(prefixArg)) {
    beside.found(besideAt(call, "mount", null));
    return;
  }
  for (const arg of args) {
    const by = servingCallOf(arg, beside.servingCalls, resolution);
    if (by !== null) {
      beside.found(besideAt(call, by, "/"));
    }
  }
}

/** Each argument after the prefix that is not one of the routers suss mounted. */
export function noteMountedBeside(
  call: CallExpression,
  args: readonly Node[],
  targetPosition: number,
  mounted: readonly Node[],
  prefix: string,
  beside: BesideMounts,
  resolution: ResolutionStore | undefined,
): void {
  const routers = new Set(mounted.map(nodeId));
  for (const arg of args.slice(targetPosition)) {
    const written = writtenNodeOf(arg, resolution);
    if (written !== null && routers.has(nodeId(written))) {
      continue;
    }
    const by = servingCallOf(arg, beside.servingCalls, resolution);
    if (by !== null) {
      beside.found(besideAt(call, by, prefix));
      continue;
    }
    if (!plainMiddleware(arg, resolution)) {
      beside.found(besideAt(call, "mount", prefix));
    }
  }
}

function besideAt(
  call: CallExpression,
  by: MountBeside["by"],
  prefix: string | null,
): MountBeside {
  return {
    by,
    prefix,
    file: call.getSourceFile().getFilePath(),
    line: call.getStartLineNumber(),
    written: call.getText().slice(0, 200),
  };
}

function writtenAsString(value: Node): boolean {
  return (
    Node.isStringLiteral(value) ||
    Node.isNoSubstitutionTemplateLiteral(value) ||
    Node.isTemplateExpression(value) ||
    value.getType().isString() ||
    value.getType().isStringLiteral()
  );
}

/** What a call to one of the pack's serving functions serves, or null for any other value. */
function servingCallOf(
  value: Node,
  servingCalls: readonly ServingCall[],
  resolution: ResolutionStore | undefined,
): ServingCall["by"] | null {
  if (!Node.isCallExpression(value) || resolution === undefined) {
    return null;
  }
  const callee = value.getExpression();
  for (const serving of servingCalls) {
    const names = resolution.importedNamesOf(callee, [serving.module]);
    if (names.some((name) => serving.names.includes(name))) {
      return serving.by;
    }
  }
  return null;
}

/**
 * Whether the value is middleware that serves no path of its own: a
 * function the project writes, or a call into a package the project
 * imports, such as a body parser.
 */
function plainMiddleware(
  value: Node,
  resolution: ResolutionStore | undefined,
): boolean {
  // A call into the project may build a router, so only a package's
  // call counts as middleware, however the call's result is typed.
  if (Node.isCallExpression(value)) {
    return callsIntoPackage(value, resolution);
  }
  return functionValueOf(value, resolution) !== null;
}

/**
 * Whether the call goes into a package the project imports rather than
 * into its own code. A path alias reads like a package name, so a call
 * that reaches one of the project's functions is never a package's.
 */
function callsIntoPackage(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): boolean {
  if (resolution === undefined) {
    return false;
  }
  const facts = factSourceFor(resolution, (value, module) =>
    resolution.originatesFrom(value, module),
  );
  if (facts.callsProjectMethod?.(nodeId(call)) === true) {
    return false;
  }
  const root = rootIdentifier(call.getExpression());
  const module =
    root === null ? null : (facts.importSpecifierOf?.(nodeId(root)) ?? null);
  return module !== null && !module.startsWith(".");
}
