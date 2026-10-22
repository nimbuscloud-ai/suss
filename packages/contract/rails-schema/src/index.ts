/**
 * Reads a Rails app's dump of its database, `db/schema.rb` or
 * `db/structure.sql`, into one storage summary per table, marked
 * `origin: "dump"`. The checker compares these with any other
 * declaration of the same tables, such as a Prisma or Drizzle copy, and
 * takes the dump as what the database contains. A dump is never paired
 * with the queries in code. The README lists what each reader reads.
 */

import fs from "node:fs";
import path from "node:path";

import { preloadRubyGrammar } from "@suss/adapter-ruby";
import { defaultProjectRoot, pathInProject } from "@suss/behavioral-ir/files";

import { tablesInSchemaRb } from "./schemaRb.js";
import { tablesInStructureSql } from "./structureSql.js";
import { type DumpTable, tableSummary } from "./table.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface RailsSchemaOptions {
  /** The path recorded on each summary, in place of the default. */
  source?: string;
  /**
   * Defaults to `"default"`, the scope every other reader gives the app's
   * own database.
   */
  scope?: string;
  /**
   * The engine behind the database, as `config/database.yml` gives it.
   * Absent or null when nothing says, and then the tables meet a
   * declaration on any engine.
   */
  storageSystem?: string | null;
  /**
   * Collects what the reader could not read, such as a statement the SQL
   * grammar rejects. Without it, each goes to stderr.
   */
  warnings?: string[];
}

export interface RailsSchemaFileOptions extends RailsSchemaOptions {
  /** Absolute. The directory the dump's path is measured from. */
  projectRoot?: string;
}

/** Converts the text of a `db/schema.rb`. */
export async function railsSchemaToSummaries(
  source: string,
  options: RailsSchemaOptions = {},
): Promise<BehavioralSummary[]> {
  await preloadRubyGrammar();
  return summariesOf(
    tablesInSchemaRb(source),
    options.source ?? "db/schema.rb",
    options,
  );
}

/** Converts the text of a `db/structure.sql`. */
export function structureSqlToSummaries(
  source: string,
  options: RailsSchemaOptions = {},
): BehavioralSummary[] {
  const file = options.source ?? "db/structure.sql";
  const read = tablesInStructureSql(source, options.storageSystem ?? null);
  if (read.unread !== null) {
    report(`${file}: ${read.unread}`, options.warnings);
  }
  return summariesOf(read.tables, file, options);
}

/**
 * Reads either dump from disk: a `.sql` file as `db/structure.sql`, and
 * anything else as `db/schema.rb`. Throws when the file does not exist.
 */
export async function railsSchemaFileToSummaries(
  file: string,
  options: RailsSchemaFileOptions = {},
): Promise<BehavioralSummary[]> {
  if (!fs.existsSync(file)) {
    throw new Error(`Rails schema not found: ${file}`);
  }
  const text = fs.readFileSync(file, "utf8");
  const { projectRoot, ...rest } = options;
  const labelled = {
    ...rest,
    source:
      options.source ??
      pathInProject(file, projectRoot ?? defaultProjectRoot(file)),
  };
  return path.extname(file) === ".sql"
    ? structureSqlToSummaries(text, labelled)
    : railsSchemaToSummaries(text, labelled);
}

function summariesOf(
  tables: readonly DumpTable[],
  file: string,
  options: RailsSchemaOptions,
): BehavioralSummary[] {
  const placement = {
    file,
    scope: options.scope ?? "default",
    storageSystem: options.storageSystem ?? null,
  };
  return tables.map((table) => tableSummary(table, placement));
}

function report(message: string, warnings: string[] | undefined): void {
  if (warnings !== undefined) {
    warnings.push(message);
    return;
  }
  process.stderr.write(`[suss] rails-schema: ${message}\n`);
}
