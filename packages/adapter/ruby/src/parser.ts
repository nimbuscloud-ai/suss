// parser.ts: loads the Ruby grammar behind web-tree-sitter.
//
// tree-sitter is the settled parser choice. It runs as WASM, needs no
// native build step, and can be swapped behind this one module if a
// fuzzer run ever asks for a different Ruby grammar. The rest of the
// adapter never imports `web-tree-sitter` directly. It goes through
// `parseRuby` and the node helpers in `ast.ts`. This mirrors the Python
// adapter's parser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Language, Parser } from "web-tree-sitter";

import type { Tree } from "web-tree-sitter";

const GRAMMAR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "grammar",
  "tree-sitter-ruby.wasm",
);

let languagePromise: Promise<Language> | null = null;
/** Set once `languagePromise` resolves, so a synchronous caller can parse without waiting on it again. */
let loadedLanguage: Language | null = null;

function loadLanguage(): Promise<Language> {
  languagePromise ??= (async () => {
    if (!fs.existsSync(GRAMMAR_PATH)) {
      throw new Error(
        `Ruby grammar not found at ${GRAMMAR_PATH}. See grammar/README.md.`,
      );
    }
    await Parser.init();
    const language = await Language.load(GRAMMAR_PATH);
    loadedLanguage = language;
    return language;
  })();
  return languagePromise;
}

/**
 * A new `Parser` for every call, so that parses running at the same time do
 * not fight over one parser's mutable `language` field. The compiled `Language`
 * is loaded once per process and shared.
 */
export async function parseRuby(source: string): Promise<Tree> {
  const language = await loadLanguage();
  return parseWith(language, source);
}

/**
 * Load the grammar ahead of time, for a caller whose own entry point is
 * async but whose parsing happens later through `parseRubySync`. Loading
 * the WASM grammar is the only async part; parsing a tree from it is not.
 */
export async function preloadRubyGrammar(): Promise<void> {
  await loadLanguage();
}

/**
 * `parseRuby` without the await, for a caller that cannot itself be
 * async. Throws if `preloadRubyGrammar` (or `parseRuby`) has not already
 * loaded the grammar in this process.
 */
export function parseRubySync(source: string): Tree {
  if (loadedLanguage === null) {
    throw new Error(
      "the Ruby grammar has not been loaded yet; call preloadRubyGrammar first",
    );
  }
  return parseWith(loadedLanguage, source);
}

function parseWith(language: Language, source: string): Tree {
  const parser = new Parser();
  parser.setLanguage(language);
  try {
    const tree = parser.parse(source);
    if (tree === null) {
      throw new Error("tree-sitter produced no tree for this source");
    }
    return tree;
  } finally {
    parser.delete();
  }
}

export type { Node as RbNode, Tree as RbTree } from "web-tree-sitter";
