import type { SourceFile } from "ts-morph";

/**
 * A result worked out from one file's parse, kept only for as long as
 * that parse lasts.
 *
 * When a file's text is replaced, ts-morph reuses the same `SourceFile`
 * wrapper and forgets every node the previous parse produced. A cache
 * keyed on the wrapper would hand a re-parsed file nodes that throw the
 * moment anything touches them. The compiler's own source file object is
 * new on every parse, so keying on that makes each entry expire exactly
 * when the nodes inside it stop working.
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
