/**
 * depTracking.ts: which other files went into a file's summaries.
 *
 * The per-file cache serves a file's summaries back without walking
 * it, so it has to know when another file's content shaped them. The
 * mechanisms that cross files are spread across the walk, discovery
 * and the resolution store, and threading a recorder through every
 * signature would touch all of them. Extraction is synchronous and
 * single-threaded, so an ambient recorder works: the walk pushes a
 * sink for the file it is on, and any code that reads another file
 * reports it to whichever sink is active. No sink active means no
 * caller is collecting, which is what `--no-cache` runs get.
 */

export interface DependencySink {
  /** Absolute paths of the other files read along the way. */
  files: Set<string>;
  /** Mount prefixes consumed, by mounted router node id, "" included. */
  mountPrefixes: Map<string, string>;
  /** Units this walk claimed, for a partial run to replay. */
  claims: { key: string; pack: string }[];
}

export function createDependencySink(): DependencySink {
  return { files: new Set(), mountPrefixes: new Map(), claims: [] };
}

let activeSink: DependencySink | null = null;

export function withDependencySink<T>(sink: DependencySink, fn: () => T): T {
  const previous = activeSink;
  activeSink = sink;
  try {
    return fn();
  } finally {
    activeSink = previous;
  }
}

export function recordFileDependency(filePath: string): void {
  activeSink?.files.add(filePath);
}

export function recordMountPrefix(childId: string, prefix: string): void {
  activeSink?.mountPrefixes.set(childId, prefix);
}

export function recordUnitClaim(key: string, pack: string): void {
  activeSink?.claims.push({ key, pack });
}
