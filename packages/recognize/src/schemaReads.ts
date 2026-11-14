/**
 * A pack that recognizes the environment variables a program reads by
 * parsing the environment against a schema:
 *
 *   cleanEnv(process.env, { PORT: port({ default: 8080 }) })
 *   Env.parse(process.env), where Env came from z.object({ ... })
 *
 * No code writes `process.env.PORT`, so the variables are the schema's
 * keys. A schema read is a config read off the environment, as a read
 * chain's are, that starts at a call: its first link is the object the
 * reads are off, and then a call chain's start and methods table say
 * which calls parse. DESIGN.md has the steps to the schema and what
 * makes a key defaulted.
 */

import { chainStart } from "./chain.js";

import type {
  Chain,
  Deployment,
  Link,
  RuntimeReadEnding,
  SchemaParse,
} from "./chain.js";
import type { CallsAndOptions, ReceiverOrigin, RuntimeObject } from "./ops.js";

/** What a pack says about the environment a schema is parsed against, and the library that parses it. */
export interface SchemaReadsSpec {
  /** The object the reads are off. */
  object: RuntimeObject;
  /** What the run says about the deployment a config read belongs to. */
  deployment?: Deployment;
  /** Where the parse call comes from. Without it, any call the table lists matches. */
  client?: ReceiverOrigin;
}

/** A chain over schema parses, and the links that can still be added. */
export interface SchemaReads {
  /** The calls that parse, with where each takes the environment and the schema. */
  methods(table: Readonly<Record<string, SchemaParse>>): SchemaReads;
  /** What in a key's schema makes its variable optional. */
  defaultedWhen(words: CallsAndOptions): SchemaReads;
  /** A call into a project function whose body parses is a read at the call. */
  throughHelpers(): SchemaReads;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): SchemaReads;
  /** The links and the ending, as data. */
  readonly declared: Chain<SchemaParse>;
}

/** A pack that recognizes the keys of a schema parsed against a runtime object. */
export function schemaReads(spec: SchemaReadsSpec): SchemaReads {
  const ending: RuntimeReadEnding = {
    yields: "runtimeRead",
    deployment: spec.deployment ?? {},
  };
  return chainFrom({
    links: [
      { asks: "off", object: spec.object },
      ...chainStart<SchemaParse>(spec.client),
    ],
    ending,
    example: null,
  });
}

/** The same chain with one more link, or with its example set. */
function chainFrom(declared: Chain<SchemaParse>): SchemaReads {
  const adding = (link: Link<SchemaParse>): SchemaReads =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    methods: (table) => adding({ asks: "methods", table, ignoringCase: false }),
    defaultedWhen: (words) =>
      adding({
        asks: "defaultedWhen",
        calls: words.calls,
        options: words.options,
      }),
    throughHelpers: () => adding({ asks: "throughHelpers" }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
