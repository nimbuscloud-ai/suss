/**
 * The SQL grammars this package parses with, one per dialect. The
 * statement readers and the schema reader both look a grammar up here.
 */

import bigquery from "node-sql-parser/build/bigquery.js";
import mysql from "node-sql-parser/build/mysql.js";
import postgresql from "node-sql-parser/build/postgresql.js";
import sqlite from "node-sql-parser/build/sqlite.js";

interface SqlParser {
  astify(sql: string, options: { database: string }): unknown;
}

interface ParserModule {
  Parser: new () => SqlParser;
}

export interface Grammar {
  module: ParserModule;
  database: string;
  /**
   * Whether the dialect writes a bind as a bare `?`, counted by where it
   * appears. The tree does not keep that order, so each `?` is numbered
   * as `$1`, `$2` before parsing, which these grammars also read.
   */
  bindsByPosition?: boolean;
}

/** The grammars, keyed by the store name a pack declares. */
export const DIALECTS: Record<string, Grammar> = {
  postgresql: { module: postgresql as ParserModule, database: "postgresql" },
  mysql: {
    module: mysql as ParserModule,
    database: "mysql",
    bindsByPosition: true,
  },
  sqlite: {
    module: sqlite as ParserModule,
    database: "sqlite",
    bindsByPosition: true,
  },
  bigquery: { module: bigquery as ParserModule, database: "bigquery" },
};

/** The parsed statement, or null when the grammar rejects it. */
export function parsedStatement(sql: string, grammar: Grammar): unknown {
  try {
    return new grammar.module.Parser().astify(sql, {
      database: grammar.database,
    });
  } catch {
    return null;
  }
}
