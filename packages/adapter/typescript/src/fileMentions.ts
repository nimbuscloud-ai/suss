import { createPerFileCache } from "./perFileCache.js";

import type { SourceFile } from "ts-morph";

const answersByFile = createPerFileCache<Map<string, boolean>>();

/**
 * Whether a file's text contains a word. A declared pack asks this before
 * it asks the store, once for every call it looks at and every module or
 * method name its chains list, so each answer is kept for as long as the
 * file's parse lasts. Without that, a file that never mentions the word
 * has its whole text scanned again for each call in it.
 */
export function fileMentions(sourceFile: SourceFile, word: string): boolean {
  let answers = answersByFile.get(sourceFile);
  if (answers === undefined) {
    answers = new Map();
    answersByFile.set(sourceFile, answers);
  }
  let found = answers.get(word);
  if (found === undefined) {
    found = sourceFile.getFullText().includes(word);
    answers.set(word, found);
  }
  return found;
}
