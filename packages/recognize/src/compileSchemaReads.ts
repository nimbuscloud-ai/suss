/**
 * Turns a schema chain into the hook the access walk calls at every call
 * it visits.
 *
 * A call that parses the environment against a schema reads one variable
 * per key of the schema. The hook looks the call's name up in the
 * methods table before anything else, since nearly every call is not a
 * parse, and only then asks where the call came from, which keys the
 * schema has, and whether the call was handed the environment. Through a
 * helper, the calls the callee writes are asked the same questions and
 * the reads are reported at the call into the helper. DESIGN.md, under
 * "A schema the environment is parsed against", has the steps.
 */

import {
  listed,
  modulesOfChain,
  operationOf,
  startsHere,
  statedValue,
} from "./compile.js";
import { configRead, linkIn, readingOf } from "./compileReads.js";
import { readIn } from "./ops.js";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";
import type {
  Chain,
  DefaultedWhenLink,
  MethodMeaning,
  MethodsLink,
  OneArgument,
  SchemaParse,
} from "./chain.js";
import type { Reading } from "./compileReads.js";
import type { CallOps, CallsAndOptions, ReadOps, ValueOps } from "./ops.js";

/** A schema chain's links, picked out once when it compiles. */
interface SchemaReading {
  readonly chain: Chain<MethodMeaning>;
  readonly reading: Reading;
  readonly methods: MethodsLink<MethodMeaning>;
  readonly modules: readonly string[];
  readonly defaulting: CallsAndOptions;
}

/** One key a parse reads, with the value its schema is written as. */
interface SchemaKey {
  readonly name: string;
  readonly value: ValueOps;
}

/** What one call parses: its keys, and the path of the environment it was handed. */
interface Parsed {
  readonly keys: readonly SchemaKey[];
  readonly path: string;
}

const NOTHING_DEFAULTS: CallsAndOptions = { calls: [], options: [] };

/** A schema chain, as the hook the adapter dispatches to on its access walk. */
export function compileSchemaReads(
  chain: Chain<MethodMeaning>,
  methods: MethodsLink<MethodMeaning>,
  recognition: string,
): AccessRecognizer {
  const schema: SchemaReading = {
    chain,
    reading: readingOf(chain, recognition),
    methods,
    modules: modulesOfChain(chain),
    defaulting:
      linkIn<DefaultedWhenLink>(chain.links, "defaultedWhen") ??
      NOTHING_DEFAULTS,
  };
  return (_access: unknown, ctx: unknown): Effect[] | null => {
    const read = readIn(ctx);
    const call = read?.call?.() ?? null;
    if (read === null || call === null) {
      return null;
    }
    const parsed = parsesAt(call, schema);
    const effects = parsed.flatMap((one) => readsOf(one, read, schema));
    return effects.length === 0 ? null : effects;
  };
}

/**
 * What the call parses itself, or else what each call written in the
 * project function it reaches parses, in source order. A config module
 * often parses its schema inside a function every handler calls.
 */
function parsesAt(call: CallOps, schema: SchemaReading): Parsed[] {
  const own = parsedBy(call, schema);
  if (own !== null) {
    return [own];
  }
  if (!schema.reading.throughHelpers) {
    return [];
  }
  return (call.callsInCallee?.() ?? []).flatMap((inner) => {
    const found = parsedBy(inner, schema);
    return found === null ? [] : [found];
  });
}

/**
 * The keys a call parses and the environment it was handed, or null when
 * it is not a parse of the environment. Most calls named `parse` parse
 * something else, so the schema is read before the environment is asked
 * about.
 */
function parsedBy(call: CallOps, schema: SchemaReading): Parsed | null {
  const meaning = parseMeaning(call, schema);
  if (meaning === null) {
    return null;
  }
  const keys = meaning.schema.flatMap((pick) => keysAt(call, pick));
  if (keys.length === 0) {
    return null;
  }
  const environment = statedValue(call, meaning.environment);
  const path = environment?.runtimePath?.(schema.reading.object);
  return path === undefined ? null : { keys, path };
}

/**
 * What the table says the call does, once the chain's start accepts it.
 * A bare call the table does not list as written is read as the export
 * the file imported it as, and that import says where it came from.
 */
function parseMeaning(
  call: CallOps,
  schema: SchemaReading,
): SchemaParse | null {
  const meaning = listed(schema.methods, operationOf(call));
  if (meaning !== null) {
    return startsHere(schema.chain, call) ? (meaning as SchemaParse) : null;
  }
  if (call.method() !== null || schema.modules.length === 0) {
    return null;
  }
  const exported = call.calleeImport?.(schema.modules) ?? null;
  return exported === null
    ? null
    : (listed(schema.methods, exported) as SchemaParse | null);
}

/** The keys of the object a schema pick reaches, each with the value its schema is written as. */
function keysAt(call: CallOps, pick: OneArgument): SchemaKey[] {
  const object = statedValue(call, pick)?.object?.() ?? null;
  if (object === null) {
    return [];
  }
  return object
    .entries("nothing")
    .flatMap((entry) =>
      entry.key === null || entry.key === ""
        ? []
        : [{ name: entry.key, value: entry.value }],
    );
}

/** One config read per key, named off the environment the call was handed. */
function readsOf(
  parsed: Parsed,
  read: ReadOps,
  schema: SchemaReading,
): Effect[] {
  return parsed.keys.map((key) =>
    configRead(
      { reads: "config" },
      {
        entry: key.name,
        reading: schema.reading,
        site: read,
        defaulted: key.value.mentions?.(schema.defaulting) ?? false,
        path: parsed.path,
      },
    ),
  );
}
