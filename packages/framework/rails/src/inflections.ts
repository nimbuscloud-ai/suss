/**
 * The acronyms a project registers with ActiveSupport's inflector.
 * Rails runs every initializer under `config/initializers`, and the
 * one `rails new` scaffolds for this is `inflections.rb`, where a
 * project writes `inflect.acronym "ActivityPub"`. An acronym changes
 * how a constant maps to a file, so a reader that does not know it
 * looks for `ActivityPub::BaseController` under `activity_pub/` and
 * finds nothing.
 *
 * The initializers are scanned as text, since this runs before the
 * Ruby grammar is loaded. Only an acronym written as a string literal
 * in the call is read; one built at runtime stays unknown.
 */

import fs from "node:fs";
import path from "node:path";

const ACRONYM_CALL = /\.acronym\s*\(?\s*(["'])([A-Za-z\d]+)\1/g;

/** Every acronym the initializers under `configDirectory` register, in name order. */
export function readAcronyms(configDirectory: string): string[] {
  const found = new Set<string>();
  for (const file of inflectionFiles(configDirectory)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(ACRONYM_CALL)) {
      found.add(match[2] ?? "");
    }
  }
  found.delete("");
  return [...found].sort();
}

/** The initializer files that register an acronym, for the cache key. */
export function inflectionFiles(configDirectory: string): string[] {
  const directory = path.join(configDirectory, "config", "initializers");
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rb"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(
      (file) => fs.readFileSync(file, "utf8").match(ACRONYM_CALL) !== null,
    )
    .sort();
}
