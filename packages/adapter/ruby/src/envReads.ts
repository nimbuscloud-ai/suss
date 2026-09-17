/**
 * envReads.ts: the environment variables a body reads through the core
 * `ENV` object. `ENV["X"]`, `ENV.fetch("X", d)` and `ENV.fetch("X") { d }`
 * become the config-read effect the TypeScript adapter emits for
 * `process.env.X`, with the same defaulted flag, so the runtime-config
 * checker pairs them against a template the same way.
 *
 * `ENV` is the language's own object, so this belongs to the adapter and
 * not to a pack. A read whose name comes from a parameter is stated as
 * `readsEnvNamed`, and the shared rules say which parameters end up
 * naming a variable, so a body calling such a helper reports the read at
 * the call. The README lists every spelling that is and is not read.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";
import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import {
  enclosingMethod,
  field,
  NodeMap,
  readCallArgs,
  stringLiteralValue,
} from "./ast.js";
import { resolvedFunctions, resolveValues } from "./facts/resolve.js";
import { calleeKeyOf, nodeId, readKey } from "./facts/values.js";
import { stringValueOf } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RbNode } from "./parser.js";

export const RUBY_ENV_RECOGNITION = "ruby-env";

/**
 * Whether a read whose name is not a literal supplies a fallback. Ruby
 * says this at the read and the rules never carry it, so the run keeps
 * it beside the `readsEnvNamed` fact under a name of its own.
 */
const ENV_DEFAULTED = "rbEnvDefaulted";

/** The project's facts and the path they key this body's file under. */
export interface EnvFacts {
  readonly db: Database;
  readonly file: string;
}

interface EnvRead {
  name: string;
  defaulted: boolean;
}

/** An `ENV` read before its name expression has been read as a string. */
interface EnvSite {
  /** The whole read, whose node id is the site the rules report. */
  readonly read: RbNode;
  /** Where the variable's name comes from. */
  readonly name: RbNode;
  readonly defaulted: boolean;
}

/** A parameter of a call's callee, with what the caller passes there. */
interface PassedArgument {
  /** The key the rules are asked about. */
  readonly param: string;
  readonly argument: RbNode;
}

/** A place in the body's source order: a read found there, or a call still to answer. */
type Slot = { readonly read: EnvRead } | { readonly call: RbNode };

/** A method or lambda body runs when it is called, so its reads wait for its own unit. */
const DEFERRED_BODY_TYPES = new Set(["method", "singleton_method", "lambda"]);

/**
 * The config-read effects for every environment read under `root`,
 * in source order. `root` itself is not read: pass a method for its
 * body, or the program node for what runs when the file loads.
 *
 * With the run's facts, a call to a project helper that reads the
 * environment through one of its parameters reports the read here too.
 */
export function envReadEffects(root: RbNode, facts?: EnvFacts): Effect[] {
  const helpers =
    facts !== undefined && hasHelperReads(facts.db) ? facts : null;
  // The calls are answered in a batch once the walk is over, so what the
  // walk keeps is a place in source order for each of them.
  const slots: Slot[] = [];
  walkDescendants<RbNode, null>(root, null, {
    at: (node) => {
      const read = envReadAt(node);
      if (read !== null) {
        slots.push({ read });
        return;
      }
      // A bare name Ruby runs as a method parses as an `identifier` and
      // passes nothing, so no name reaches a helper through one.
      if (helpers !== null && node.type === "call") {
        slots.push({ call: node });
      }
    },
    into: (node) => (DEFERRED_BODY_TYPES.has(node.type) ? SKIP_CHILDREN : null),
  });

  const calls = slots.flatMap((slot) => ("call" in slot ? [slot.call] : []));
  const throughHelpers =
    helpers === null ? new NodeMap<EnvRead[]>() : helperReads(calls, helpers);
  return slots.flatMap((slot) => {
    if ("read" in slot) {
      return [configReadEffect(slot.read)];
    }
    return (throughHelpers.get(slot.call) ?? []).map(configReadEffect);
  });
}

/** Whether anything in the run reads the environment under a name it is given. */
function hasHelperReads(db: Database): boolean {
  return db.facts("readsEnvNamed").length > 0;
}

/**
 * State which reads take their name from an expression, so the shared
 * rules can say which parameters a caller's argument ends up naming.
 */
export function emitEnvNameFacts(
  db: Database,
  file: string,
  root: RbNode,
): void {
  for (const site of envNameSites(root)) {
    const key = nodeId(file, site.read);
    db.add("readsEnvNamed", [
      key,
      readKey(file, site.name, enclosingMethod(site.name)),
    ]);
    if (site.defaulted) {
      db.add(ENV_DEFAULTED, [key]);
    }
  }
}

/**
 * Every `ENV` read under `root` whose name is an expression rather than
 * a string literal, method bodies included, since that is where a
 * helper's read is written.
 */
function envNameSites(root: RbNode): EnvSite[] {
  const sites: EnvSite[] = [];
  walkDescendants<RbNode, null>(root, null, {
    at: (node) => {
      const site = envSiteAt(node);
      if (site !== null && stringLiteralValue(site.name) === null) {
        sites.push(site);
      }
    },
    into: () => null,
  });
  return sites;
}

/**
 * The environment reads each of a body's calls reaches through a project
 * helper. Every callee is resolved in one round and every parameter
 * asked in the next, so a body costs two questions rather than two per
 * call.
 */
function helperReads(
  calls: readonly RbNode[],
  facts: EnvFacts,
): NodeMap<EnvRead[]> {
  const { db, file } = facts;
  const callees = new NodeMap<string>();
  for (const call of calls) {
    const key = calleeKeyOf(file, call, enclosingMethod(call));
    if (key !== null) {
      callees.set(call, key);
    }
  }
  const reads = new NodeMap<EnvRead[]>();
  if (callees.size === 0) {
    return reads;
  }
  resolveValues(
    db,
    [...callees].map(([, callee]) => callee),
  );

  const passed = new NodeMap<PassedArgument[]>();
  const asked: string[] = [];
  for (const [call, callee] of callees) {
    const args = argumentsByParameter(db, call, callee);
    if (args.length === 0) {
      continue;
    }
    passed.set(call, args);
    asked.push(...args.map((arg) => arg.param));
  }
  if (asked.length === 0) {
    return reads;
  }
  resolveValues(db, asked);

  for (const [call, args] of passed) {
    const found = readsAtCall(db, call, args);
    if (found.length > 0) {
      reads.set(call, found);
    }
  }
  return reads;
}

/** Each parameter of every function this call settles on, with the argument filling it. */
function argumentsByParameter(
  db: Database,
  call: RbNode,
  callee: string,
): PassedArgument[] {
  const { positional, keyword } = readCallArgs(field(call, "arguments"));
  const found: PassedArgument[] = [];
  for (const func of resolvedFunctions(db, callee)) {
    for (const row of db.lookup("paramOf", 0, func)) {
      const argument = positional[Number(row[1])];
      if (argument !== undefined) {
        found.push({ param: String(row[2]), argument });
      }
    }
    for (const row of db.lookup("paramNamed", 0, func)) {
      const argument = keyword[String(row[1])];
      if (argument !== undefined) {
        found.push({ param: String(row[2]), argument });
      }
    }
  }
  return found;
}

/**
 * The variables this call reads, by asking what its callee's parameters
 * name and reading the matching argument as a string. One name read at
 * two sites is one read, defaulted only where every site supplies a
 * fallback.
 */
function readsAtCall(
  db: Database,
  call: RbNode,
  args: readonly PassedArgument[],
): EnvRead[] {
  const defaultedAtCall = isDefaultedAt(call);
  const byName = new Map<string, boolean>();
  for (const { param, argument } of args) {
    const sites = db.lookup("wantedParamNamesEnv", 0, param);
    if (sites.length === 0) {
      continue;
    }
    const name = stringLiteralValue(argument) ?? stringValueOf(argument, db);
    if (name === null) {
      continue;
    }
    for (const row of sites) {
      const defaulted =
        defaultedAtCall ||
        db.lookup(ENV_DEFAULTED, 0, String(row[1])).length > 0;
      byName.set(name, (byName.get(name) ?? true) && defaulted);
    }
  }
  return [...byName].map(([name, defaulted]) => ({ name, defaulted }));
}

function configReadEffect(read: EnvRead): Effect {
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: RUBY_ENV_RECOGNITION,
      deploymentTarget: "lambda",
      instanceName: "<unknown>",
    }),
    callee: `ENV["${read.name}"]`,
    interaction: {
      class: "config-read",
      name: read.name,
      defaulted: read.defaulted,
    },
  };
}

function envReadAt(node: RbNode): EnvRead | null {
  const site = envSiteAt(node);
  if (site === null) {
    return null;
  }
  const name = stringLiteralValue(site.name);
  return name === null ? null : { name, defaulted: site.defaulted };
}

function envSiteAt(node: RbNode): EnvSite | null {
  if (node.type === "element_reference") {
    return elementSite(node);
  }
  if (node.type === "call") {
    return fetchSite(node);
  }
  return null;
}

/** `ENV["X"]`, which is nil when the variable is unset unless an `||` supplies a fallback. */
function elementSite(node: RbNode): EnvSite | null {
  const object = field(node, "object");
  if (object === null || !isEnv(object) || isAssignedTo(node)) {
    return null;
  }
  const index = node.namedChildren.find(
    (child): child is RbNode => child !== null && child.id !== object.id,
  );
  if (index === undefined) {
    return null;
  }
  return { read: node, name: index, defaulted: isDefaultedAt(node) };
}

/** `ENV.fetch("X")`, defaulted when a second argument or a block supplies the fallback. */
function fetchSite(node: RbNode): EnvSite | null {
  const receiver = field(node, "receiver");
  if (
    receiver === null ||
    !isEnv(receiver) ||
    field(node, "method")?.text !== "fetch"
  ) {
    return null;
  }
  const { positional } = readCallArgs(field(node, "arguments"));
  const name = positional[0];
  if (name === undefined) {
    return null;
  }
  const hasDefault = positional.length > 1 || field(node, "block") !== null;
  return { read: node, name, defaulted: hasDefault || isDefaultedAt(node) };
}

/** The core `ENV` object, written bare or as `::ENV`. */
function isEnv(node: RbNode): boolean {
  if (node.type === "constant") {
    return node.text === "ENV";
  }
  return (
    node.type === "scope_resolution" &&
    field(node, "scope") === null &&
    field(node, "name")?.text === "ENV"
  );
}

/** `ENV["X"] = v` changes the environment rather than reading it. */
function isAssignedTo(node: RbNode): boolean {
  const parent = node.parent;
  return (
    parent !== null &&
    (parent.type === "assignment" || parent.type === "operator_assignment") &&
    field(parent, "left")?.id === node.id
  );
}

/**
 * Whether an `||` supplies a value when this read comes back nil. The
 * climb continues through a chain, so B in `A || B || "d"` counts, and
 * stops where the read is the final operand and is itself the fallback.
 */
function isDefaultedAt(node: RbNode): boolean {
  let child = node;
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === "parenthesized_statements") {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (parent.type !== "binary" || field(parent, "operator")?.text !== "||") {
      return false;
    }
    if (field(parent, "left")?.id === child.id) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}
