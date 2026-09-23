/**
 * The environment variables a body reads through Ruby's `ENV` object.
 * `ENV["X"]`, `ENV.fetch("X", d)` and `ENV.fetch("X") { d }` become the
 * config-read effect the TypeScript adapter emits for `process.env.X`,
 * with the same defaulted flag, so the runtime-config checker pairs them
 * with a template the same way.
 *
 * `ENV` is part of the language, so this belongs to the adapter and not
 * to a pack. Every expression that passes `ENV` somewhere becomes an
 * `environmentObject` fact. One question over those facts returns every
 * parameter whose value ends up naming a variable, so a body that calls
 * such a helper reports the read at the call.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";
import { SKIP_CHILDREN, walkDescendants } from "@suss/extractor";

import {
  enclosingDefinition,
  field,
  NodeMap,
  readCallArgs,
  stringLiteralValue,
} from "./ast.js";
import { isDefaultedAt } from "./defaulted.js";
import { envSpellingAt, isEnv } from "./envSpellings.js";
import {
  resolvedFunctions,
  resolveEnvObjects,
  resolveValues,
} from "./facts/resolve.js";
import { calleeKeyOf, invokedKeyOf, nodeId, readKey } from "./facts/values.js";
import { stringValueOf } from "./values/evaluator.js";

import type { Effect } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RbNode } from "./parser.js";

export const RUBY_ENV_RECOGNITION = "ruby-env";

/**
 * Marks a read whose variable name is not a literal and which supplies a
 * fallback. The fallback is written at the read and the shared rules do
 * not carry it, so the adapter records it in a relation of its own. A
 * read site with no row here has no fallback.
 */
const ENV_DEFAULTED = "rbEnvDefaulted";

/** The project's facts, and the path they use as this body's file key. */
export interface EnvFacts {
  readonly db: Database;
  readonly file: string;
}

/** The same facts, for a run with at least one helper that reads the environment. */
interface HelperFacts extends EnvFacts {
  /** Each parameter whose value becomes a variable name, with the read sites that name reaches. */
  readonly named: ReadonlyMap<string, readonly string[]>;
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

/** What a caller passes for a parameter the rules found. */
interface NamingArgument {
  /** The reads the parameter's value supplies the name to. */
  readonly sites: readonly string[];
  readonly argument: RbNode;
}

/** A place in the body's source order: a read found there, or a call still to resolve. */
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
  const helpers = helperFactsOf(facts);
  // The calls are resolved in one batch after the walk, so the walk keeps
  // a slot for each one to preserve source order.
  const slots: Slot[] = [];
  walkDescendants<RbNode, null>(root, null, {
    at: (node) => {
      const read = envReadAt(node);
      if (read !== null) {
        slots.push({ read });
        return;
      }
      // A bare method call parses as an `identifier` and takes no
      // arguments, so it cannot pass a name to a helper.
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

/**
 * The run's facts with the parameters that name a variable, or null when
 * no parameter in the run does. The body's calls are then skipped.
 */
function helperFactsOf(facts: EnvFacts | undefined): HelperFacts | null {
  if (facts === undefined) {
    return null;
  }
  const named = namedParameters(facts.db);
  if (named.size === 0) {
    return null;
  }
  return { ...facts, named };
}

/** The answer, kept per run, since the question covers the whole project. */
const namedByDb = new WeakMap<Database, Map<string, string[]>>();

/**
 * Every parameter whose value ends up naming an environment variable,
 * mapped to the read sites the name reaches. It asks one question per
 * run, starting from the expressions that spell `ENV`, and follows the
 * name through any number of helpers. The reads cannot be the starting
 * point, because a read through a parameter is made on an object no scan
 * of the source would recognize as `ENV`.
 */
function namedParameters(db: Database): ReadonlyMap<string, readonly string[]> {
  const memo = namedByDb.get(db);
  if (memo !== undefined) {
    return memo;
  }
  const named = new Map<string, string[]>();
  namedByDb.set(db, named);
  const objects = db.facts("environmentObject").map((row) => String(row[0]));
  if (objects.length === 0) {
    return named;
  }
  resolveEnvObjects(db, objects);
  for (const row of db.facts("wantedParamNamesEnv")) {
    const found = named.get(String(row[0]));
    if (found === undefined) {
      named.set(String(row[0]), [String(row[1])]);
      continue;
    }
    found.push(String(row[1]));
  }
  return named;
}

/**
 * Records which expressions spell `ENV` and pass it on, so the shared
 * rules can work out which parameters a caller's argument ends up
 * naming. Also records the fallback flag the rules do not carry.
 */
export function emitEnvFacts(db: Database, file: string, root: RbNode): void {
  walkDescendants<RbNode, null>(root, null, {
    at: (node) => {
      if (isEnv(node) && handsOnward(node)) {
        db.add("environmentObject", [
          readKey(file, node, enclosingDefinition(node)),
        ]);
      }
      const spelling = envSpellingAt(node);
      if (
        spelling !== null &&
        stringLiteralValue(spelling.name) === null &&
        envSiteAt(node)?.defaulted === true
      ) {
        db.add(ENV_DEFAULTED, [nodeId(file, node)]);
      }
    },
    into: () => null,
  });
}

/**
 * Whether `ENV` is used for anything other than a read of a literal
 * variable name. A file whose reads all write out their variable passes
 * `ENV` nowhere, so the rules have nothing to follow.
 */
function handsOnward(node: RbNode): boolean {
  const parent = node.parent;
  if (parent === null) {
    return true;
  }
  if (parent.type === "element_reference" || parent.type === "call") {
    const spelling = envSpellingAt(parent);
    return spelling === null || stringLiteralValue(spelling.name) === null;
  }
  return true;
}

/**
 * The environment reads each of a body's calls reaches through a project
 * helper. The callees are resolved in one round, so a body costs one
 * question instead of one per call. Which parameters name a variable
 * was already settled once for the whole run.
 */
function helperReads(
  calls: readonly RbNode[],
  facts: HelperFacts,
): NodeMap<EnvRead[]> {
  const { db, file, named } = facts;
  const callees = new NodeMap<string[]>();
  for (const call of calls) {
    const enclosing = enclosingDefinition(call);
    const keys = [
      calleeKeyOf(file, call, enclosing),
      invokedKeyOf(file, call, enclosing),
    ].filter((key): key is string => key !== null);
    if (keys.length > 0) {
      callees.set(call, keys);
    }
  }
  const reads = new NodeMap<EnvRead[]>();
  if (callees.size === 0) {
    return reads;
  }
  resolveValues(
    db,
    [...callees].flatMap(([, keys]) => keys),
  );

  for (const [call, callee] of callees) {
    const args = namingArguments(db, named, call, callee);
    if (args.length === 0) {
      continue;
    }
    const found = readsAtCall(db, call, args);
    if (found.length > 0) {
      reads.set(call, found);
    }
  }
  return reads;
}

/**
 * The arguments this call passes for parameters that name a variable,
 * across every function the callee settles on. A Ruby call is keyed both
 * as a method call and as an invocation of a value, so it comes with a
 * key for each.
 */
function namingArguments(
  db: Database,
  named: ReadonlyMap<string, readonly string[]>,
  call: RbNode,
  callees: readonly string[],
): NamingArgument[] {
  const { positional, keyword } = readCallArgs(field(call, "arguments"));
  const found: NamingArgument[] = [];
  for (const func of callees.flatMap((key) => resolvedFunctions(db, key))) {
    for (const row of db.lookup("paramOf", 0, func)) {
      const sites = named.get(String(row[2]));
      const argument = positional[Number(row[1])];
      if (sites !== undefined && argument !== undefined) {
        found.push({ sites, argument });
      }
    }
    for (const row of db.lookup("paramNamed", 0, func)) {
      const sites = named.get(String(row[2]));
      const argument = keyword[String(row[1])];
      if (sites !== undefined && argument !== undefined) {
        found.push({ sites, argument });
      }
    }
  }
  return found;
}

/**
 * The variables this call reads, reading each naming argument as a
 * string. One name read at two sites is one read, defaulted only where
 * every site supplies a fallback.
 */
function readsAtCall(
  db: Database,
  call: RbNode,
  args: readonly NamingArgument[],
): EnvRead[] {
  const defaultedAtCall = isDefaultedAt(call);
  const byName = new Map<string, boolean>();
  for (const { sites, argument } of args) {
    const name = stringLiteralValue(argument) ?? stringValueOf(argument, db);
    if (name === null) {
      continue;
    }
    for (const site of sites) {
      const defaulted =
        defaultedAtCall || db.lookup(ENV_DEFAULTED, 0, site).length > 0;
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
  const spelling = envSpellingAt(node);
  if (spelling === null) {
    return null;
  }
  return {
    read: node,
    name: spelling.name,
    defaulted: spelling.hasDefault || isDefaultedAt(node, spelling),
  };
}
