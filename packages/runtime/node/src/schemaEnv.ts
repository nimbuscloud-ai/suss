/**
 * The environment variables a program reads by parsing `process.env`
 * against a schema, rather than one property at a time.
 *
 *   const Env = z.object({ PORT: z.coerce.number().default(8080) });
 *   export function loadConfig(env = process.env) { return Env.parse(env); }
 *
 * Nothing here spells `process.env.PORT`, so the property readers see
 * one read of the environment object and no variable names at all. The
 * variable names are the schema literal's keys. `SCHEMA_READERS` is the
 * whole library-specific part, so covering a library is one more entry
 * rather than another walk. The README says which spellings that
 * reaches and what this declines to guess at.
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
import type { CallExpression, Node, SourceFile } from "ts-morph";

/** Where the call takes the environment object from. */
type EnvironmentAt =
  /** The argument at this position is the environment object. */
  | { in: "argument"; at: number }
  /** A named property of the object literal at this position is. */
  | { in: "property"; at: number; named: string };

/** Where the call takes the schema object literal from. */
type SchemaAt =
  /** The argument at this position is the schema literal. */
  | { in: "argument"; at: number }
  /** Named properties of the literal at this position each have one. */
  | { in: "properties"; at: number; named: readonly string[] }
  /** The argument at this position is a builder call with one in it. */
  | { in: "builtAt"; at: number; builders: readonly string[] }
  /** The call's receiver is a builder call with one in it. */
  | { in: "builtAtReceiver"; builders: readonly string[] };

interface SchemaReader {
  /** The packages whose call this is. */
  modules: readonly string[];
  /** What the source writes: the exported function, or the method. */
  calls: readonly string[];
  /**
   * Set where `calls` describes a method on a schema the library built
   * rather than a function the program imported. Nothing about such a
   * callee says which package it came from, so the package is settled
   * from the receiver instead.
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

/** One variable a schema key asks for, before it becomes an effect. */
export interface SchemaEnvRead {
  name: string;
  defaulted: boolean;
}

const PARSE_CALL_NAMES = new Set(
  SCHEMA_READERS.flatMap((reader) => [...reader.calls]),
);

/** The packages a file's text mentions, worked out once per file. */
const MODULES_MENTIONED = new WeakMap<SourceFile, ReadonlySet<string>>();

/** How the source spells the callee, for the cheap tests. */
function writtenCalleeName(callee: Node): string | null {
  if (N.isIdentifier(callee)) {
    return callee.getText();
  }
  return N.isPropertyAccessExpression(callee) ? callee.getName() : null;
}

function modulesMentionedIn(sourceFile: SourceFile): ReadonlySet<string> {
  const remembered = MODULES_MENTIONED.get(sourceFile);
  if (remembered !== undefined) {
    return remembered;
  }
  const text = sourceFile.getFullText();
  const found = new Set(
    SCHEMA_READERS.flatMap((reader) => [...reader.modules]).filter((module) =>
      text.includes(module),
    ),
  );
  MODULES_MENTIONED.set(sourceFile, found);
  return found;
}

/**
 * Whether to put any question to the store about this call, for this
 * reader. Every project calls something spelled `parse`, few of those
 * are a schema, and asking which package one came from is a query.
 *
 * A method on a schema says nothing about the package, so the zod
 * reader gets the name test alone and settles the package later, off
 * the receiver. The rest are imported functions, and an import a file
 * never mentions is one nothing in it can be calling.
 */
function readerCouldFire(
  call: CallExpression,
  reader: SchemaReader,
  written: string,
): boolean {
  if (!reader.calls.includes(written)) {
    return false;
  }
  if (reader.onSchema === true) {
    return true;
  }
  const mentioned = modulesMentionedIn(call.getSourceFile());
  return reader.modules.some((module) => mentioned.has(module));
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
  const written = writtenCalleeName(call.getExpression());
  if (written === null || !PARSE_CALL_NAMES.has(written)) {
    return [];
  }
  for (const reader of SCHEMA_READERS) {
    if (
      !readerCouldFire(call, reader, written) ||
      !callMatches(call, reader, resolution)
    ) {
      continue;
    }
    // Most `parse(text)` calls are not parsing against a schema, so the
    // schema is read before the store is asked about the argument.
    const reads = readsFromSchema(call, reader, resolution);
    if (reads.length === 0) {
      continue;
    }
    const environment = environmentArgument(call, reader, resolution);
    if (environment !== null && resolution.isEnvironmentValue(environment)) {
      return reads;
    }
  }
  return [];
}

/** Whether the source wrote this call the way the reader describes. */
function callMatches(
  call: CallExpression,
  reader: SchemaReader,
  resolution: ResolutionStore,
): boolean {
  const callee = call.getExpression();
  if (reader.onSchema === true) {
    return (
      N.isPropertyAccessExpression(callee) &&
      reader.calls.includes(callee.getName())
    );
  }
  const name = moduleCallName(callee, reader.modules, resolution);
  return name !== null && reader.calls.includes(name);
}

/**
 * The name a package exports this callee under. An imported name is
 * already that name; a property read off a namespace, or off the
 * package's root object, is the property's own name, once the value it
 * was read off comes from the package.
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
): SchemaEnvRead[] {
  return schemaLiterals(call, reader, resolution).flatMap((literal) =>
    keysOf(literal, resolution),
  );
}

/**
 * The object literals with the schema keys in them. Several for a
 * library that splits its variables by who may see them, one for the
 * rest.
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
 * The literal a library's own schema builder was given, through however
 * many refinements the program chained onto it: `z.object({ ... })` and
 * `z.object({ ... }).strict()` describe the same keys.
 */
function builtSchema(
  value: Node,
  modules: readonly string[],
  builders: readonly string[],
  resolution: ResolutionStore,
): Node[] {
  const built = chainRoot(writtenCallOf(value, resolution));
  if (built === null) {
    return [];
  }
  const name = moduleCallName(built.getExpression(), modules, resolution);
  if (name === null || !builders.includes(name)) {
    return [];
  }
  const literal = built.getArguments()[0];
  return literal === undefined ? [] : [literal];
}

/** The call a value comes down to, written out here or bound to a name. */
function writtenCallOf(
  value: Node,
  resolution: ResolutionStore,
): CallExpression | null {
  const written = writtenNodeOf(value, resolution);
  return written !== null && N.isCallExpression(written) ? written : null;
}

/** The call at the bottom of a chain of methods called on its result. */
function chainRoot(call: CallExpression | null): CallExpression | null {
  let at = call;
  while (at !== null) {
    const callee = at.getExpression();
    if (!N.isPropertyAccessExpression(callee)) {
      return at;
    }
    const receiver = callee.getExpression();
    if (!N.isCallExpression(receiver)) {
      return at;
    }
    at = receiver;
  }
  return null;
}

/** One read per key the schema literal sets. */
function keysOf(literal: Node, resolution: ResolutionStore): SchemaEnvRead[] {
  const object = objectLiteralOf(literal, resolution);
  if (object === null) {
    return [];
  }
  const reads: SchemaEnvRead[] = [];
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
 * The calls that make a variable's absence something the program has
 * already dealt with. A schema that accepts undefined belongs to a
 * program that does not need the variable set.
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

/** Whether the program supplies a value when the variable is absent. */
function suppliesValue(value: Node): boolean {
  let found = defaults(value);
  value.forEachDescendant((node, traversal) => {
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

/**
 * The reads a function makes by parsing a schema in its own body, for a
 * reader standing at a call to it. The answer belongs to the callee
 * rather than the call, so a helper twenty handlers call is walked once.
 */
const SCHEMA_READS_INSIDE = new WeakMap<Node, SchemaEnvRead[]>();

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
