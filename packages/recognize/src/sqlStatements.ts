/**
 * The entry point for a pack whose calls hand the store a statement
 * written as SQL.
 *
 * With a typed client, the call's arguments show which table it
 * reached. With a raw statement that information is in the SQL text,
 * so the chain passes the text to `@suss/sql`. The parse gives the
 * container, the kind, the fields and the selector of every table the
 * statement touches. Every link before that point is one any other
 * chain uses too, so SQL is a chain ending and needs no separate
 * grammar.
 */

import { chainStart } from "./chain.js";
import { memberContainerLink } from "./storage.js";

import type {
  ArgumentPick,
  Chain,
  InterpolatesLink,
  Link,
  SqlEnding,
  SqlMethod,
  StorageSystem,
} from "./chain.js";
import type { ReceiverOrigin } from "./ops.js";
import type { MemberContainer } from "./storage.js";

/** What a pack says about the store its statements reach. */
export interface SqlStatementsSpec {
  /**
   * The store, in the words OpenTelemetry's semantic conventions use, or
   * a rule that reads it from the project each call's file belongs to.
   */
  system: StorageSystem;
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
  dialect: StorageSystem;
  /** How the pack pins down the client its calls are on. */
  client?: ReceiverOrigin;
  /**
   * Which walk the chain runs on. A client that takes its statement as
   * a call's argument and never as a tagged template keeps its accesses
   * among the call effects, which come before the access walk's.
   * Defaults to "access".
   */
  walk?: "invocation" | "access";
}

/** A chain over statements, and the links that can still be added. */
export interface SqlStatements {
  /** Which methods take a statement, and where each one states it. */
  methods(
    table: Readonly<Record<string, SqlMethod>>,
    options?: { ignoringCase?: boolean },
  ): SqlStatements;
  /** What the values a statement interpolates come to. */
  interpolating(says: Omit<InterpolatesLink, "asks">): SqlStatements;
  /**
   * Which namespace a statement's bare tables are in, when the call says
   * rather than the pack. A table the statement qualifies keeps its own:
   * `dataset("core").query(sql)` reads `events` as `core.events` and
   * `other.events` as itself.
   */
  scope(says: ArgumentPick): SqlStatements;
  /**
   * The container as the member the call is made on, for a store whose
   * contract declares the database and not its tables. Each call is then
   * one access on that member: a write when the statement writes any
   * table, else a read, with no fields and no selector, since the tables
   * in the statement are not what the access is on.
   */
  container(says: MemberContainer): SqlStatements;
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
    ...(spec.walk === undefined ? {} : { walk: spec.walk }),
  };
  const client = spec.client;
  return chainFrom({
    links: chainStart(client),
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
    interpolating: (says) => adding({ asks: "interpolates", ...says }),
    scope: (says) => adding({ asks: "scope", argument: says }),
    container: (says) => adding(memberContainerLink(says)),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
