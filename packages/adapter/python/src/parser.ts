// parser.ts: loads the Python grammar behind web-tree-sitter.
//
// tree-sitter is the settled parser choice (see
// docs/internal/roadmap-second-language.md and
// docs/internal/proposals/language-adapters.md): WASM, no native build
// step, swappable behind this one module if a fuzzer run ever asks for
// a different Python grammar. The rest of the adapter never imports
// `web-tree-sitter` directly; it goes through `parsePython` and the
// node helpers in `ast.ts`.

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
 * Parse one file's Python source into a tree-sitter tree.
 *
 * A fresh `Parser` per call, because `Parser` instances are cheap and
 * this keeps concurrent parses (extraction runs across many files)
 * from fighting over one parser's mutable `language` field. The
 * compiled `Language` itself is loaded once per process and shared.
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
