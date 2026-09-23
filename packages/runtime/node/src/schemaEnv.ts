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
import type { CallExpression, Node, SourceFile } from "ts-morph";

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

/** A variable read through one key of a schema. */
export interface SchemaEnvRead {
  name: string;
  defaulted: boolean;
}

const PARSE_CALL_NAMES = new Set(
  SCHEMA_READERS.flatMap((reader) => [...reader.calls]),
);

/** The packages a file's text mentions, worked out once per file. */
const MODULES_MENTIONED = new WeakMap<SourceFile, ReadonlySet<string>>();

/** The callee's name as written, for the checks that need no store query. */
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
 * Checks that run before any store query, since most calls named `parse`
 * are not schemas. A schema method shows no package, so for zod only the
 * name is checked here and the package is checked later on the receiver.
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

/** True when the call is written the way the reader describes. */
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
): SchemaEnvRead[] {
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
