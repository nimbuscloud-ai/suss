import type { Project } from "ts-morph";

/**
 * A memo for results worked out from more than one file of a project.
 *
 * A per-file cache expires on its own when its file is parsed again,
 * because it is keyed on that parse. A result about one file that read
 * another, such as the helper an import resolves to, does not expire that
 * way: the importing file keeps its parse while the helper's file is read
 * again. A process that keeps a project between runs refreshes the files
 * that changed and then calls `forgetProgramMemos`, which empties every
 * memo made here for that project.
 */
export interface ProgramMemo<K extends object, V> {
  get(project: Project, key: K): V | undefined;
  set(project: Project, key: K, value: V): void;
}

const memos: Array<WeakMap<Project, WeakMap<object, unknown>>> = [];

export function createProgramMemo<K extends object, V>(): ProgramMemo<K, V> {
  const byProject = new WeakMap<Project, WeakMap<object, unknown>>();
  memos.push(byProject);
  return {
    get(project, key) {
      return byProject.get(project)?.get(key) as V | undefined;
    },
    set(project, key, value) {
      let entries = byProject.get(project);
      if (entries === undefined) {
        entries = new WeakMap();
        byProject.set(project, entries);
      }
      entries.set(key, value);
    },
  };
}

/** Empties every program memo for this project. */
export function forgetProgramMemos(project: Project): void {
  for (const byProject of memos) {
    byProject.delete(project);
  }
}
