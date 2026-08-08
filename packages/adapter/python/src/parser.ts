// parser.ts: loads the Python grammar behind web-tree-sitter.
//
// tree-sitter is the settled parser choice. It runs as WASM, needs no
// native build step, and can be swapped behind this one module if a
// fuzzer run ever asks for a different Python grammar. The rest of the
// adapter never imports `web-tree-sitter` directly. It goes through
// `parsePython` and the node helpers in `ast.ts`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Language, Parser } from "web-tree-sitter";

import type { Tree } from "web-tree-sitter";

const GRAMMAR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "grammar",
  "tree-sitter-python.wasm",
);

let languagePromise: Promise<Language> | null = null;

function loadLanguage(): Promise<Language> {
  languagePromise ??= (async () => {
    if (!fs.existsSync(GRAMMAR_PATH)) {
      throw new Error(
        `Python grammar not found at ${GRAMMAR_PATH}. See grammar/README.md.`,
      );
    }
    await Parser.init();
    return Language.load(GRAMMAR_PATH);
  })();
  return languagePromise;
}

/**
 * A new `Parser` for every call, so that parses running at the same time do
 * not fight over one parser's mutable `language` field. The compiled `Language`
 * is loaded once per process and shared.
 */
export async function parsePython(source: string): Promise<Tree> {
  const language = await loadLanguage();
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

export type { Node as PyNode, Tree as PyTree } from "web-tree-sitter";
