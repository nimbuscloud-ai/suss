import type { SourceFile } from "ts-morph";

/**
 * An answer worked out from one file's parse, kept only for as long as
 * that parse lasts.
 *
 * ts-morph hands back the same `SourceFile` wrapper when a file's text
 * is replaced, and it forgets every node the previous parse produced.
 * A cache keyed on the wrapper therefore answers a re-parsed file with
 * nodes that throw the moment anything touches them. The compiler's
 * own source file object is new per parse, so keying on it makes the
 * entry expire exactly when the nodes in it stop being usable.
 */
export interface PerFileCache<T> {
  get(sourceFile: SourceFile): T | undefined;
  set(sourceFile: SourceFile, value: T): void;
}

export function createPerFileCache<T>(): PerFileCache<T> {
  const byParse = new WeakMap<object, T>();
  return {
    get(sourceFile) {
      return byParse.get(sourceFile.compilerNode);
    },
    set(sourceFile, value) {
      byParse.set(sourceFile.compilerNode, value);
    },
  };
}
