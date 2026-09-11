/**
 * What a project teaches ActiveSupport's inflector.
 *
 * Rails runs every initializer under `config/initializers`, and the one
 * `rails new` scaffolds for this is `inflections.rb`, where a project
 * writes `inflect.acronym "ActivityPub"` or `inflect.irregular "person",
 * "people"`. An acronym changes how a constant maps to a file, and the
 * rest change which class `has_many :people` reaches.
 *
 * The initializers are scanned as text, since this runs before the Ruby
 * grammar is loaded. Comments are dropped first, because the scaffolded
 * file writes every example out in one.
 */

import fs from "node:fs";
import path from "node:path";

import type { RbInflections } from "@suss/adapter-ruby";

const ACRONYM_CALL = /\.acronym\s*\(?\s*(["'])([A-Za-z\d]+)\1/g;

/** `inflect.irregular "person", "people"`: the singular first, then the plural. */
const IRREGULAR_CALL =
  /\.irregular\s*\(?\s*(["'])([^"']*)\1\s*,\s*(["'])([^"']*)\3/g;

/** `inflect.uncountable "rice"` and `inflect.uncountable %w( fish sheep )`. */
const UNCOUNTABLE_CALL = /\.uncountable\s*\(?\s*([^\n]*)/g;

/** `inflect.singular "data", "data"` and `inflect.singular(/(quiz)zes$/i, '\1')`. */
const SINGULAR_CALL =
  /\.singular\s*\(?\s*(?:(["'])([^"']*)\1|\/([^/]*)\/([a-z]*))\s*,\s*(["'])([^"']*)\5/g;

/** The words inside a `%w( a b )` or `%i[ a b ]` list. */
const WORD_LIST = /%[wi][([{]([^)\]}]*)[)\]}]/;

/** Every string literal in a fragment, for `uncountable "a", "b"`. */
const EVERY_LITERAL = /(["'])([^"']*)\1/g;

/** Whether an initializer teaches the inflector anything, which is what puts it in the cache key. */
const ANY_CALL = /\.(acronym|irregular|uncountable|singular)[\s("'/]/;

/** The text a group matched. Every group in the patterns above is part of its match. */
function group(match: RegExpMatchArray, at: number): string {
  return match[at] ?? "";
}

/** Everything the initializers under `configDirectory` teach the inflector. */
export function readInflections(
  configDirectory: string,
): Required<RbInflections> {
  const acronyms = new Set<string>();
  const irregular: Array<[string, string]> = [];
  const uncountable = new Set<string>();
  const singular: Array<[string, string]> = [];

  for (const file of inflectionFiles(configDirectory)) {
    const source = uncommented(fs.readFileSync(file, "utf8"));
    for (const match of source.matchAll(ACRONYM_CALL)) {
      acronyms.add(group(match, 2));
    }
    for (const match of source.matchAll(IRREGULAR_CALL)) {
      irregular.push([group(match, 4), group(match, 2)]);
    }
    for (const match of source.matchAll(UNCOUNTABLE_CALL)) {
      for (const word of wordsIn(group(match, 1))) {
        uncountable.add(word);
      }
    }
    for (const match of source.matchAll(SINGULAR_CALL)) {
      singular.push([ruleOf(match), group(match, 6)]);
    }
  }
  acronyms.delete("");
  uncountable.delete("");

  return {
    acronyms: [...acronyms].sort(),
    irregular,
    uncountable: [...uncountable].sort(),
    singular,
  };
}

/** A rule written as a string, or one written as a regex literal kept in the `/body/flags` spelling. */
function ruleOf(match: RegExpMatchArray): string {
  const literal = match[2];
  return literal === undefined
    ? `/${group(match, 3)}/${group(match, 4)}`
    : literal;
}

/** Every acronym the initializers register, in name order. */
export function readAcronyms(configDirectory: string): string[] {
  return readInflections(configDirectory).acronyms;
}

/** The words an `uncountable` argument lists, written either as a `%w()` list or as plain literals. */
function wordsIn(argument: string): string[] {
  const list = WORD_LIST.exec(argument);
  if (list !== null) {
    return group(list, 1)
      .split(/\s+/)
      .filter((word) => word.length > 0);
  }
  return [...argument.matchAll(EVERY_LITERAL)].map((match) => group(match, 2));
}

/** The initializer files that teach the inflector anything, for the cache key. */
export function inflectionFiles(configDirectory: string): string[] {
  const directory = path.join(configDirectory, "config", "initializers");
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rb"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => ANY_CALL.test(uncommented(fs.readFileSync(file, "utf8"))))
    .sort();
}

function uncommented(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}
