/**
 * Records which Postgres tables a Ruby body reads and writes through the
 * pg gem.
 *
 * Ruby has no type annotations, so the adapter types a receiver by
 * following it back to the gem call that opened the connection. The
 * README covers which calls that reaches and which it leaves out.
 */

import type { RbRawSqlPattern, RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

// Provider summaries spell the store this way, and a call pairs with them
// only when the spelling matches.
const STORAGE_SYSTEM = "postgresql";

// The `prepare` calls take a statement name first, so their statement is
// the second argument.
const STATEMENTS: NonNullable<RbRawSqlPattern["statements"]> = {
  exec: { at: 0 },
  exec_params: { at: 0 },
  async_exec: { at: 0 },
  async_exec_params: { at: 0 },
  sync_exec: { at: 0 },
  sync_exec_params: { at: 0 },
  query: { at: 0 },
  send_query: { at: 0 },
  send_query_params: { at: 0 },
  prepare: { at: 1 },
  async_prepare: { at: 1 },
  sync_prepare: { at: 1 },
};

/**
 * The pg gem's raw SQL patterns. `PG.connect` and the three builders on
 * `PG::Connection` open the same kind of connection, so a receiver built
 * by any of them counts.
 */
export function pgRawSql(): RbRawSqlPattern[] {
  const calls = {
    statements: STATEMENTS,
    storageSystem: STORAGE_SYSTEM,
    dialect: STORAGE_SYSTEM,
  };
  return [
    { constantName: "PG", clientBuilders: ["connect"], ...calls },
    {
      constantName: "PG::Connection",
      clientBuilders: ["new", "connect", "open"],
      ...calls,
    },
  ];
}

/**
 * Adds the pg gem's patterns to another Ruby pack, such as the Rails
 * pack. A project that queries Postgres directly usually runs a web
 * framework too, and the result keeps that pack's discovery and any raw
 * SQL patterns it already had.
 */
export function withPg(pack: RubyPack): RubyPack {
  return {
    ...pack,
    rawSql: [...(pack.rawSql ?? []), ...pgRawSql()],
  };
}

export function pgRubyFramework(): RubyPack {
  return {
    name: "pg-ruby",
    protocol: STORAGE_SYSTEM,
    discovery: [],
    rawSql: pgRawSql(),
  };
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-pg-ruby",
  dependencies: [{ ecosystem: "rubygems", name: "pg" }],
  reads:
    "pg gem calls (Ruby): a call matches when its receiver follows back to a connection the gem handed out, and the statement it was given is parsed for the tables it touches.",
};

export default pgRubyFramework;
