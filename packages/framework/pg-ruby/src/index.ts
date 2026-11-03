/**
 * Records which Postgres tables a Ruby body reads and writes through the
 * pg gem.
 *
 * Ruby has no type annotations, so a receiver counts when it follows back
 * to the gem call that opened the connection. The README covers which
 * calls that reaches and which it leaves out.
 */

import { constructedFrom, pack, sqlStatements } from "@suss/recognize";

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";
import type { PatternPack, SqlMethod } from "@suss/recognize";

// Provider summaries spell the store this way, and a call pairs with them
// only when the spelling matches.
const STORAGE_SYSTEM = "postgresql";

const STATEMENT_FIRST: SqlMethod = { statement: { at: 0 } };

// The `prepare` calls take a statement name first.
const STATEMENT_SECOND: SqlMethod = { statement: { at: 1 } };

// `PG.connect`, and `new`, `connect` and `open` on `PG::Connection`, open
// the same kind of connection.
const CONNECTION = constructedFrom({
  from: ["PG"],
  named: ["connect", "open", "Connection"],
});

const QUERIES = sqlStatements({
  system: STORAGE_SYSTEM,
  dialect: STORAGE_SYSTEM,
  client: CONNECTION,
}).methods({
  exec: STATEMENT_FIRST,
  exec_params: STATEMENT_FIRST,
  async_exec: STATEMENT_FIRST,
  async_exec_params: STATEMENT_FIRST,
  sync_exec: STATEMENT_FIRST,
  sync_exec_params: STATEMENT_FIRST,
  query: STATEMENT_FIRST,
  send_query: STATEMENT_FIRST,
  send_query_params: STATEMENT_FIRST,
  prepare: STATEMENT_SECOND,
  async_prepare: STATEMENT_SECOND,
  sync_prepare: STATEMENT_SECOND,
});

/** The pg gem's queries, declared once for any adapter that runs them. */
export function pgQueries(): PatternPack {
  return pack("pg-ruby", [QUERIES], {
    languages: ["ruby"],
    recognizedAs: "ruby-raw-sql",
  });
}

/**
 * Adds the pg gem's queries to another Ruby pack, such as the Rails
 * pack. A project that queries Postgres directly usually runs a web
 * framework too, and the result keeps that pack's discovery and the
 * hooks it already had.
 */
export function withPg(pack: RubyPack): RubyPack {
  const queries = pgQueries();
  return {
    ...pack,
    invocationRecognizers: [
      ...(pack.invocationRecognizers ?? []),
      ...(queries.invocationRecognizers ?? []),
    ],
    accessRecognizers: [
      ...(pack.accessRecognizers ?? []),
      ...(queries.accessRecognizers ?? []),
    ],
  };
}

export function pgRubyFramework(): RubyPack {
  return withPg({
    name: "pg-ruby",
    protocol: STORAGE_SYSTEM,
    discovery: [],
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-pg-ruby",
  dependencies: [{ ecosystem: "rubygems", name: "pg" }],
  reads:
    "pg gem calls (Ruby): a call matches when its receiver follows back to a connection the gem handed out, and the statement it was given is parsed for the tables it touches.",
};

export default pgRubyFramework;
