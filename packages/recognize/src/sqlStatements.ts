/**
 * The entry point for a pack whose calls hand the store a statement
 * written as SQL.
 *
 * A typed client says what it reached in its arguments, so the chain
 * asks the call. A raw statement says it in the text, so the chain
 * hands the text to `@suss/sql` and the parse settles the container,
 * the kind, the fields and the selector of every table the statement
 * touches. The links up to that point are the same ones every chain
 * states, which is why this is an ending rather than a grammar of its
 * own.
 */

import type { Chain, Link, SqlEnding, SqlMethod } from "./chain.js";
import type { ReceiverOrigin } from "./ops.js";

/** What a pack says about the store its statements reach. */
export interface SqlStatementsSpec {
  /** The store, in the words OpenTelemetry's semantic conventions use. */
  system: string;
  /** The wire, when it differs from the store's own name. */
  transport?: string;
  /** Which of the store's namespaces the calls reach. Defaults to "default". */
  scope?: string;
  /**
   * Which dialect the statements are written in. Wherever the store is
   * the database this is the store's own name again, and a pack says it
   * anyway: a store whose statements are somebody else's SQL is common
   * enough that a default here would read the wrong tables quietly.
   */
  dialect: string;
  /** How the pack pins down the client its calls are on. */
  client?: ReceiverOrigin;
}

/** A chain over statements, and the links that can still be added. */
export interface SqlStatements {
  /** Which methods take a statement, and where each one states it. */
  methods(
    table: Readonly<Record<string, SqlMethod>>,
    options?: { ignoringCase?: boolean },
  ): SqlStatements;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): SqlStatements;
  /** The links and the ending, as data. */
  readonly declared: Chain<SqlMethod>;
}

/** A pack that recognizes statements written as SQL. */
export function sqlStatements(spec: SqlStatementsSpec): SqlStatements {
  const ending: SqlEnding = {
    yields: "sqlAccess",
    system: spec.system,
    ...(spec.transport === undefined ? {} : { transport: spec.transport }),
    scope: spec.scope ?? "default",
    dialect: spec.dialect,
  };
  const client = spec.client;
  return chainFrom({
    links:
      client === undefined
        ? []
        : [{ asks: "start", at: { starts: "receiver", origin: client } }],
    ending,
    example: null,
  });
}

/** The same chain with one more link, or with its example set. */
function chainFrom(declared: Chain<SqlMethod>): SqlStatements {
  const adding = (link: Link<SqlMethod>): SqlStatements =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    methods: (table, options) =>
      adding({
        asks: "methods",
        table,
        ignoringCase: options?.ignoringCase ?? false,
      }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
