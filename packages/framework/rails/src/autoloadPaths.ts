/**
 * Reads the directories a project adds to Rails' autoloader in
 * `config/application.rb`, so a constant under `lib` resolves the way it
 * does at run time.
 *
 * Rails autoloads every directory under `app` by itself, and a project
 * adds more with `config.eager_load_paths << Rails.root.join("lib")`,
 * `config.autoload_paths += %W[#{config.root}/lib]` or, from Rails 7.1,
 * `config.autoload_lib(ignore: ...)`. The file is scanned as text, since
 * this runs before the Ruby grammar is loaded. A path built any other
 * way, such as from a `Dir[...]` glob, is not read.
 */

import fs from "node:fs";
import path from "node:path";

/** `config.eager_load_paths << ...` and `config.autoload_paths += ...`, up to the end of the line. */
const ADDED_PATHS =
  /config\.(?:eager_load_paths|autoload_paths|autoload_once_paths)\s*(?:<<|\+=|\.push\(|\.unshift\(|\.concat\()\s*([^\n]*)/g;

/** `Rails.root.join("lib")` and `Rails.root.join("enterprise", "lib")`. */
const ROOT_JOIN = /Rails\.root\.join\(\s*([^)]*)\)/g;

/** `"#{Rails.root}/lib"`, `"#{config.root}/lib"` and the same inside `%W[...]`. */
const INTERPOLATED_ROOT = /#\{(?:Rails\.root|config\.root|root)\}\/([\w./-]+)/g;

const AUTOLOAD_LIB = /config\.autoload_lib(?:_once)?\b/;

/** Every string literal in a fragment. */
const EVERY_LITERAL = /(["'])([^"']*)\1/g;

/** `config/application.rb` under `configDirectory`, when there is one, for the cache key. */
export function applicationFile(configDirectory: string): string[] {
  const file = applicationPath(configDirectory);
  return fs.existsSync(file) ? [file] : [];
}

function applicationPath(configDirectory: string): string {
  return path.join(configDirectory, "config", "application.rb");
}

/** The absolute directories `config/application.rb` under `configDirectory` adds, in the order it adds them. */
export function readAutoloadRoots(configDirectory: string): string[] {
  const file = applicationPath(configDirectory);
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const relative: string[] = [];
  for (const line of source.split("\n")) {
    if (line.trimStart().startsWith("#")) {
      continue;
    }
    if (AUTOLOAD_LIB.test(line)) {
      relative.push("lib");
    }
    for (const added of line.matchAll(ADDED_PATHS)) {
      relative.push(...directoriesIn(added[1] ?? ""));
    }
  }
  return [...new Set(relative)]
    .map((directory) => path.resolve(configDirectory, directory))
    .filter((directory) => isDirectory(directory));
}

function directoriesIn(fragment: string): string[] {
  const joined = [...fragment.matchAll(ROOT_JOIN)].map((join) =>
    [...(join[1] ?? "").matchAll(EVERY_LITERAL)]
      .map((literal) => literal[2] ?? "")
      .join("/"),
  );
  const interpolated = [...fragment.matchAll(INTERPOLATED_ROOT)].map(
    (match) => match[1] ?? "",
  );
  return [...joined, ...interpolated].filter((one) => one !== "");
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}
