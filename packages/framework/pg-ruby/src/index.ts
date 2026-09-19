/**
 * Which Postgres tables a Ruby body reads and writes through the pg gem.
 *
 * The gem hands a connection out from `PG` or `PG::Connection`, and every
 * statement goes through a call on that connection. Ruby writes no types,
 * so the adapter types a receiver by following it back to the gem call
 * that produced it. The README says what that reaches and what it leaves
 * out.
 */

import type { RbRawSqlPattern, RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

/** The store, spelled the way every provider summary spells it. */
const STORAGE_SYSTEM = "postgresql";

/**
 * The calls that take a statement. `prepare` takes a name first and the
 * statement second; everything else takes the statement first, whether
 * it waits for the result or not.
 */
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
 * The two constants the gem hands a connection out from. `PG.connect`
 * and the three calls on `PG::Connection` all open the same thing, and
 * a project writes whichever it likes.
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
 * Add the pg gem to whichever pack a run already uses. A web framework
 * and a database library are separate libraries and a project picks
 * both, so this composes rather than replacing anything.
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

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-pg-ruby",
  dependencies: [{ ecosystem: "rubygems", name: "pg" }],
  reads:
    "pg gem calls (Ruby): a call matches when its receiver follows back to a connection the gem handed out, and the statement it was given is parsed for the tables it touches.",
};

export default pgRubyFramework;
