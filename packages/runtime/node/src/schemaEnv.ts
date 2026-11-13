/**
 * The environment variables a program reads by parsing `process.env`
 * against a schema.
 *
 *   const Env = z.object({ PORT: z.coerce.number().default(8080) });
 *   export function loadConfig(env = process.env) { return Env.parse(env); }
 *
 * No code here writes `process.env.PORT`, so the property readers find
 * one read of the environment object and no variable names. The names
 * are the keys of the schema literal. All the library-specific detail is
 * in `SCHEMA_READERS`, so supporting another library means adding an
 * entry there. The README lists the spellings this covers.
 */

import { Node as N, SyntaxKind } from "ts-morph";

import {
  objectLiteralOf,
  propertiesOf,
  propertyNameOf,
  propertyOf,
  propertyValueOf,
  writtenNodeOf,
} from "@suss/adapter-typescript";

import type { ResolutionStore } from "@suss/adapter-typescript";
import type { CallExpression, Node } from "ts-morph";

/** Where the call takes the environment object from. */
type EnvironmentAt =
  /** The argument at this position. */
  | { in: "argument"; at: number }
  /** A named property of the object literal at this position. */
  | { in: "property"; at: number; named: string };

/** Where the call takes the schema object literal from. */
type SchemaAt =
  /** The argument at this position. */
  | { in: "argument"; at: number }
  /** Named properties of the object literal at this position, each a schema. */
  | { in: "properties"; at: number; named: readonly string[] }
  /** A builder call at this position, whose argument is the schema. */
  | { in: "builtAt"; at: number; builders: readonly string[] }
  /** A builder call as the call's receiver, whose argument is the schema. */
  | { in: "builtAtReceiver"; builders: readonly string[] };

interface SchemaReader {
  /** The packages that export the call. */
  modules: readonly string[];
  /** The exported function or method name, as the source writes it. */
  calls: readonly string[];
  /**
   * Set when `calls` are methods on a schema object the library built.
   * The callee does not show which package it came from, so the package
   * is checked through the receiver.
   */
  onSchema?: true;
  environment: EnvironmentAt;
  schema: SchemaAt;
}

const SCHEMA_READERS: readonly SchemaReader[] = [
  // cleanEnv(process.env, { PORT: port({ default: 8080 }), DB_NAME: str() })
  {
    modules: ["envalid"],
    calls: ["cleanEnv"],
    environment: { in: "argument", at: 0 },
    schema: { in: "argument", at: 1 },
  },
  // parseEnv(process.env, { PORT: z.number().default(8080) })
  {
    modules: ["znv"],
    calls: ["parseEnv"],
    environment: { in: "argument", at: 0 },
    schema: { in: "argument", at: 1 },
  },
  // createEnv({ server: { DB_NAME: z.string() }, runtimeEnv: process.env })
  {
    modules: ["@t3-oss/env-core", "@t3-oss/env-nextjs"],
    calls: ["createEnv"],
    environment: { in: "property", at: 0, named: "runtimeEnv" },
    schema: { in: "properties", at: 0, named: ["server", "client", "shared"] },
  },
  // v.parse(v.object({ DB_NAME: v.string() }), process.env)
  {
    modules: ["valibot"],
    calls: ["parse", "safeParse", "parseAsync", "safeParseAsync"],
    environment: { in: "argument", at: 1 },
    schema: { in: "builtAt", at: 0, builders: ["object"] },
  },
  // Env.parse(process.env), where Env came from z.object({ ... })
  {
    modules: ["zod"],
    calls: ["parse", "safeParse", "parseAsync", "safeParseAsync"],
    onSchema: true,
    environment: { in: "argument", at: 0 },
    schema: { in: "builtAtReceiver", builders: ["object"] },
  },
];

/** One key of a schema, and whether it accepts a missing variable. */
interface SchemaKey {
  name: string;
  defaulted: boolean;
}

/** A variable read through one key of a schema, and the environment object the call parsed. */
export interface SchemaEnvRead extends SchemaKey {
  object: string;
}

/** The callee's name as written, for the checks that need no store query. */
function writtenCalleeName(callee: Node): string | null {
  if (N.isIdentifier(callee)) {
    return callee.getText();
  }
  return N.isPropertyAccessExpression(callee) ? callee.getName() : null;
}

/**
 * Every environment variable a call reads by parsing the environment
 * against a schema. Empty for every other call, which is nearly all of
 * them, so the cheap tests come first.
 */
export function schemaEnvReads(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): SchemaEnvRead[] {
  if (resolution === undefined) {
    return [];
  }
  const callee = call.getExpression();
  const written = writtenCalleeName(callee);
  if (written === null) {
    return [];
  }
  for (const reader of SCHEMA_READERS) {
    if (!callMatches(callee, written, reader, resolution)) {
      continue;
    }
    // Most `parse(text)` calls are not parsing against a schema, so the
    // schema is read before the store is asked about the argument.
    const keys = readsFromSchema(call, reader, resolution);
    if (keys.length === 0) {
      continue;
    }
    const environment = environmentArgument(call, reader, resolution);
    if (environment !== null && resolution.isEnvironmentValue(environment)) {
      const object = resolution.environmentReadOff(environment);
      return keys.map((key) => ({ ...key, object }));
    }
  }
  return [];
}

/**
 * True when the call is written the way the reader describes: one of its
 * calls off a schema, for zod, and otherwise one of its calls as the
 * library exports it. A schema method shows no package, so for zod the
 * package is checked later on the receiver.
 */
function callMatches(
  callee: Node,
  written: string,
  reader: SchemaReader,
  resolution: ResolutionStore,
): boolean {
  if (reader.onSchema === true) {
    return (
      N.isPropertyAccessExpression(callee) && reader.calls.includes(written)
    );
  }
  const name = reader.calls.includes(written)
    ? moduleCallName(callee, reader.modules, resolution)
    : importedUnderAlias(callee, reader.modules);
  return name !== null && reader.calls.includes(name);
}

/**
 * The name one of the modules exports a bare callee under, when the file
 * imported it from there under another name. It is read off the import
 * itself, so a call to any other function asks the store nothing.
 */
function importedUnderAlias(
  callee: Node,
  modules: readonly string[],
): string | null {
  if (!N.isIdentifier(callee)) {
    return null;
  }
  for (const declaration of callee.getSymbol()?.getDeclarations() ?? []) {
    if (
      N.isImportSpecifier(declaration) &&
      modules.includes(
        declaration.getImportDeclaration().getModuleSpecifierValue(),
      )
    ) {
      return declaration.getName();
    }
  }
  return null;
}

/**
 * The name the package exports this callee under. A property read off a
 * namespace import or the package's root object uses its own name.
 */
function moduleCallName(
  callee: Node,
  modules: readonly string[],
  resolution: ResolutionStore,
): string | null {
  if (N.isIdentifier(callee)) {
    return resolution.importedNamesOf(callee, [...modules])[0] ?? null;
  }
  if (!N.isPropertyAccessExpression(callee)) {
    return null;
  }
  const fromPackage = resolution.importedNamesOf(callee.getExpression(), [
    ...modules,
  ]);
  return fromPackage.length > 0 ? callee.getName() : null;
}

function environmentArgument(
  call: CallExpression,
  reader: SchemaReader,
  resolution: ResolutionStore,
): Node | null {
  const at = call.getArguments()[reader.environment.at];
  if (at === undefined) {
    return null;
  }
  if (reader.environment.in === "argument") {
    return at;
  }
  return namedValue(at, reader.environment.named, resolution);
}

function readsFromSchema(
  call: CallExpression,
  reader: SchemaReader,
  resolution: ResolutionStore,
): SchemaKey[] {
  return schemaLiterals(call, reader, resolution).flatMap((literal) =>
    keysOf(literal, resolution),
  );
}

/**
 * The object literals that contain the schema keys. A library that splits
 * variables into server and client groups has several, the others one.
 */
function schemaLiterals(
  call: CallExpression,
  reader: SchemaReader,
  resolution: ResolutionStore,
): Node[] {
  const { schema } = reader;
  if (schema.in === "builtAtReceiver") {
    const callee = call.getExpression();
    if (!N.isPropertyAccessExpression(callee)) {
      return [];
    }
    return builtSchema(
      callee.getExpression(),
      reader.modules,
      schema.builders,
      resolution,
    );
  }

  const at = call.getArguments()[schema.at];
  if (at === undefined) {
    return [];
  }
  if (schema.in === "argument") {
    return [at];
  }
  if (schema.in === "builtAt") {
    return builtSchema(at, reader.modules, schema.builders, resolution);
  }
  return schema.named
    .map((name) => namedValue(at, name, resolution))
    .filter((found): found is Node => found !== null);
}

/** What an object literal, written out or referred to, sets a name to. */
function namedValue(
  value: Node,
  named: string,
  resolution: ResolutionStore,
): Node | null {
  const object = objectLiteralOf(value, resolution);
  return object === null ? null : propertyOf(object, named, resolution);
}

/**
 * How many calls up its receivers the walk to a schema's builder goes.
 * A schema with more refinements chained onto it than this loses its
 * keys, and a receiver that comes back round to itself ends the walk.
 */
const MAX_BUILDER_HOPS = 8;

/**
 * The literal a library's own schema builder was given, through however
 * many refinements the program chained onto it, written in place or kept
 * in a name: `z.object({ ... })`, `z.object({ ... }).strict()` and
 * `Base.strict()` after `const Base = z.object({ ... })` describe the
 * same keys.
 */
function builtSchema(
  value: Node,
  modules: readonly string[],
  builders: readonly string[],
  resolution: ResolutionStore,
): Node[] {
  let at = writtenCallOf(value, resolution);
  for (let hops = 0; at !== null && hops <= MAX_BUILDER_HOPS; hops += 1) {
    if (isBuilder(at, modules, builders, resolution)) {
      const literal = at.getArguments()[0];
      return literal === undefined ? [] : [literal];
    }
    at = receiverCallOf(at, resolution);
  }
  return [];
}

/**
 * Whether the call is one of the library's builders, called off a value
 * the library exports or as the export itself. The method's name is
 * looked at before the store is asked about the receiver.
 */
function isBuilder(
  call: CallExpression,
  modules: readonly string[],
  builders: readonly string[],
  resolution: ResolutionStore,
): boolean {
  const callee = call.getExpression();
  if (
    N.isPropertyAccessExpression(callee) &&
    !builders.includes(callee.getName())
  ) {
    return false;
  }
  const name = moduleCallName(callee, modules, resolution);
  return name !== null && builders.includes(name);
}

/** The call a method was called on, written in place or kept in a name. */
function receiverCallOf(
  call: CallExpression,
  resolution: ResolutionStore,
): CallExpression | null {
  const callee = call.getExpression();
  return N.isPropertyAccessExpression(callee)
    ? writtenCallOf(callee.getExpression(), resolution)
    : null;
}

/** The call a value comes down to, written out here or bound to a name. */
function writtenCallOf(
  value: Node,
  resolution: ResolutionStore,
): CallExpression | null {
  const written = writtenNodeOf(value, resolution);
  return written !== null && N.isCallExpression(written) ? written : null;
}

/** One read per key the schema literal sets. */
function keysOf(literal: Node, resolution: ResolutionStore): SchemaKey[] {
  const object = objectLiteralOf(literal, resolution);
  if (object === null) {
    return [];
  }
  const reads: SchemaKey[] = [];
  for (const property of propertiesOf(object, resolution)) {
    const name = propertyNameOf(property);
    if (name === null || name.length === 0) {
      continue;
    }
    const value = propertyValueOf(property);
    reads.push({ name, defaulted: value !== null && suppliesValue(value) });
  }
  return reads;
}

/**
 * A key whose schema calls one of these accepts a missing variable, so
 * the program does not need it set.
 */
const DEFAULTING_CALLS = new Set([
  "default",
  "optional",
  "nullish",
  "catch",
  "or",
]);

/** The options an envalid validator takes a fallback under. */
const DEFAULTING_OPTIONS = new Set(["default", "devDefault"]);

/**
 * Whether the program supplies a value when the variable is absent. A
 * function written in the key runs on the value later, so a call inside
 * it says nothing about whether the variable may be missing.
 */
function suppliesValue(value: Node): boolean {
  if (N.isFunctionLikeDeclaration(value)) {
    return false;
  }
  let found = defaults(value);
  value.forEachDescendant((node, traversal) => {
    if (N.isFunctionLikeDeclaration(node)) {
      traversal.skip();
      return;
    }
    if (!defaults(node)) {
      return;
    }
    found = true;
    traversal.stop();
  });
  return found;
}

function defaults(node: Node): boolean {
  if (N.isCallExpression(node)) {
    const written = writtenCalleeName(node.getExpression());
    return written !== null && DEFAULTING_CALLS.has(written);
  }
  if (!N.isPropertyAssignment(node)) {
    return false;
  }
  const option = propertyNameOf(node);
  return option !== null && DEFAULTING_OPTIONS.has(option);
}

/** Cached by callee, so a helper that twenty handlers call is walked once. */
const SCHEMA_READS_INSIDE = new WeakMap<Node, SchemaEnvRead[]>();

/** The reads a function makes by parsing a schema in its own body. */
export function schemaEnvReadsInside(
  callee: Node,
  resolution: ResolutionStore | undefined,
): SchemaEnvRead[] {
  const remembered = SCHEMA_READS_INSIDE.get(callee);
  if (remembered !== undefined) {
    return remembered;
  }
  const found = callee
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .flatMap((inner) => schemaEnvReads(inner, resolution));
  SCHEMA_READS_INSIDE.set(callee, found);
  return found;
}
