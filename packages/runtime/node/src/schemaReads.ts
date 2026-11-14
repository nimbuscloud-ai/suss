/**
 * The environment variables a program reads by parsing the environment
 * against a schema, declared as one `schemaReads` chain per library:
 *
 *   const Env = z.object({ PORT: z.coerce.number().default(8080) });
 *   export function loadConfig(env = process.env) { return Env.parse(env); }
 *
 * No code writes `process.env.PORT`, so the variables are the schema's
 * keys, each a config read at the call that parses. A call into a
 * project function whose body parses reads them at the call too. The
 * README lists the spellings each library covers.
 */

import {
  anyOf,
  constructedFrom,
  global,
  imported,
  schemaReads,
} from "@suss/recognize";

import type {
  CallsAndOptions,
  Deployment,
  Match,
  ReceiverOrigin,
  SchemaParse,
} from "@suss/recognize";

const ENVIRONMENT = global("process.env", "import.meta.env");

/** The four ways zod and valibot parse a value against a schema. */
const PARSES = ["parse", "safeParse", "parseAsync", "safeParseAsync"];

/**
 * A key accepts a missing variable when its schema calls one of these,
 * or sets one of envalid's fallback options.
 */
const DEFAULTED: CallsAndOptions = {
  calls: ["default", "optional", "nullish", "catch", "or"],
  options: ["default", "devDefault"],
};

/** A library's own function, imported by name or read off the module. */
function exported(
  from: readonly string[],
  named: readonly string[],
): ReceiverOrigin {
  return anyOf(
    constructedFrom({ from, named }),
    imported({ from, named: ["*", "default"] }),
  );
}

/** The same parse under each of these names. */
function parsedBy(
  names: readonly string[],
  parse: SchemaParse,
): Record<string, SchemaParse> {
  return Object.fromEntries(names.map((name) => [name, parse]));
}

/** valibot takes the schema first, built by its `object`, and the environment after it. */
const VALIBOT_PARSE: SchemaParse = {
  environment: { at: 1 },
  schema: [
    {
      of: [
        { to: "argument", at: 0 },
        { to: "builder", method: "object", from: ["valibot"] },
      ],
      at: 0,
    },
  ],
};

/** zod parses with a method of the schema, which its `object` built. */
const ZOD_PARSE: SchemaParse = {
  environment: { at: 0 },
  schema: [
    {
      of: [
        { to: "receiver" },
        { to: "builder", method: "object", from: ["zod"] },
      ],
      at: 0,
    },
  ],
};

/**
 * One chain per library, in the order their effects are recorded at a
 * call. At most one of them parses any one call.
 */
export function schemaReadMatches(deployment: Deployment): Match[] {
  const envalid = schemaReads({
    object: ENVIRONMENT,
    deployment,
    client: exported(["envalid"], ["cleanEnv"]),
  })
    .methods({ cleanEnv: { environment: { at: 0 }, schema: [{ at: 1 }] } })
    .defaultedWhen(DEFAULTED)
    .throughHelpers()
    .example("cleanEnv(process.env, { PORT: port({ default: 8080 }) })");

  const znv = schemaReads({
    object: ENVIRONMENT,
    deployment,
    client: exported(["znv"], ["parseEnv"]),
  })
    .methods({ parseEnv: { environment: { at: 0 }, schema: [{ at: 1 }] } })
    .defaultedWhen(DEFAULTED)
    .throughHelpers()
    .example("parseEnv(process.env, { PORT: z.number().default(8080) })");

  // t3-env takes one object, with the environment and the variables of
  // each audience under their own keys.
  const t3 = schemaReads({
    object: ENVIRONMENT,
    deployment,
    client: exported(["@t3-oss/env-core", "@t3-oss/env-nextjs"], ["createEnv"]),
  })
    .methods({
      createEnv: {
        environment: { at: 0, path: ["runtimeEnv"] },
        schema: [
          { at: 0, path: ["server"] },
          { at: 0, path: ["client"] },
          { at: 0, path: ["shared"] },
        ],
      },
    })
    .defaultedWhen(DEFAULTED)
    .throughHelpers()
    .example(
      "createEnv({ server: { DATABASE_URL: z.string() }, runtimeEnv: process.env })",
    );

  const valibot = schemaReads({
    object: ENVIRONMENT,
    deployment,
    client: exported(["valibot"], PARSES),
  })
    .methods(parsedBy(PARSES, VALIBOT_PARSE))
    .defaultedWhen(DEFAULTED)
    .throughHelpers()
    .example(
      "v.parse(v.object({ PORT: v.optional(v.string()) }), process.env)",
    );

  // Any receiver can be a zod schema, so the chain has no client, and
  // the builder step says the schema is zod's.
  const zod = schemaReads({ object: ENVIRONMENT, deployment })
    .methods(parsedBy(PARSES, ZOD_PARSE))
    .defaultedWhen(DEFAULTED)
    .throughHelpers()
    .example("z.object({ PORT: z.string() }).parse(process.env)");

  return [envalid, znv, t3, valibot, zod];
}
