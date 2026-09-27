/**
 * The adapters a long-lived process keeps between reads of one project.
 *
 * The CLI builds an adapter per run and throws it away. The MCP server
 * reads the same project after every edit, and building the adapter again
 * means parsing every file again. So the server hands `extract` one of
 * these, and each read of an entry takes the adapter the last read of that
 * entry left, provided it was made the same way. A read made differently,
 * such as one with a pack added or its config edited, gets a new adapter
 * in that entry's place.
 */

interface Slot {
  key: string;
  value: unknown;
  prepare: (() => Promise<void>) | undefined;
}

export class KeptAdapters {
  private readonly slots = new Map<string, Slot>();
  private changed = new Set<string>();
  private changedThisRead: string[] = [];

  /**
   * The value kept in `slot` when it was made with the same `key`, or a
   * new one from `make` that replaces whatever was there. `prepare` is
   * work the value can do ahead of the next read, which `prepare()` runs.
   */
  keep<T>(
    slot: string,
    key: string,
    make: () => T,
    prepare?: (value: T) => Promise<void>,
  ): T {
    const held = this.slots.get(slot);
    if (held !== undefined && held.key === key) {
      return held.value as T;
    }
    const value = make();
    this.slots.set(slot, {
      key,
      value,
      prepare: prepare === undefined ? undefined : () => prepare(value),
    });
    return value;
  }

  /**
   * Does the work each kept adapter can do before the next read, such as
   * building a program that a read served from the cache never loaded.
   */
  async prepare(): Promise<void> {
    for (const slot of this.slots.values()) {
      await slot.prepare?.();
    }
  }

  /** Files a watcher saw written, for the next read to look at first. */
  noteChanged(paths: Iterable<string>): void {
    for (const one of paths) {
      this.changed.add(one);
    }
  }

  /**
   * Called as a read starts. The files noted before now go to this read,
   * and a file noted while it runs waits for the next one.
   */
  startRead(): void {
    this.changedThisRead = [...this.changed];
    this.changed = new Set();
  }

  /** The files noted before the current read started. */
  changedPaths(): readonly string[] {
    return this.changedThisRead;
  }

  /** Drops every adapter, so the memory they use can be reclaimed. */
  release(): void {
    this.slots.clear();
  }

  /** How many adapters are kept, for a caller reporting on its memory. */
  get size(): number {
    return this.slots.size;
  }
}
