/**
 * Parses a process keeps between runs of one project, by file.
 *
 * The Python and Ruby adapters parse every file on every run, because
 * facts are emitted over the whole project. A process that reads the same
 * project after every edit hands a run one of these, and a file whose text
 * is the same as last time gets last time's tree back. The trees are
 * WASM memory the garbage collector cannot see, so a tree that is replaced
 * or whose file went away is handed to `release`.
 */
export class KeptParses<T> {
  private readonly byFile = new Map<string, { source: string; value: T }>();

  constructor(private readonly release: (value: T) => void = () => {}) {}

  async parse(
    file: string,
    source: string,
    make: (source: string) => Promise<T>,
  ): Promise<T> {
    const kept = this.byFile.get(file);
    if (kept !== undefined && kept.source === source) {
      return kept.value;
    }
    const value = await make(source);
    if (kept !== undefined) {
      this.release(kept.value);
    }
    this.byFile.set(file, { source, value });
    return value;
  }

  /** Lets go of every file not in this run. */
  keepOnly(files: Iterable<string>): void {
    const wanted = new Set(files);
    for (const [file, kept] of this.byFile) {
      if (!wanted.has(file)) {
        this.release(kept.value);
        this.byFile.delete(file);
      }
    }
  }
}
