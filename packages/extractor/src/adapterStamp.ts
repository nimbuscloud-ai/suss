/**
 * The language-neutral half of an adapter's cache key.
 *
 * Each adapter calls `createAdapterStamp` once, with its own
 * `import.meta.url` and its hand-bumped version, and keeps the result for
 * the life of the process. The stamp hashes the adapter's dist file and
 * every analysis package shipped with it (this package, `@suss/resolution`,
 * `@suss/datalog`, `@suss/behavioral-ir`). A release that changes any of
 * them invalidates an older cache, and so does a local rebuild, with no
 * version bump. Running from source leaves no dist file to hash, so that
 * mode turns the cache off. This package's DESIGN.md describes the cache.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ANALYSIS_PACKAGES = [
  "@suss/extractor",
  "@suss/resolution",
  "@suss/datalog",
  "@suss/behavioral-ir",
];

/**
 * Whether this process can see the adapter's own code. `bundle` includes
 * a hash that changes whenever the code does. `source` means no bundle was
 * found, so a cache key built from this stamp cannot tell two builds apart.
 */
export type AdapterCodeStamp =
  | { kind: "bundle"; hash: string }
  | { kind: "source" };

const SOURCE_STAMP: AdapterCodeStamp = { kind: "source" };

export interface AdapterStamp {
  /** The stamp for the running adapter, computed once per process. */
  codeStamp(): AdapterCodeStamp;
  /**
   * A cache key for this adapter and its packs. It is the same across
   * processes for the same inputs, and changes when a pack's version, the
   * adapter's version, or the adapter's dist file changes.
   */
  packsDigest(
    packVersions: ReadonlyArray<{ name: string; version?: string }>,
  ): string;
  /**
   * Returns `cacheDir`, or null when this process loaded the adapter from
   * source, since then one build cannot be told from another. The first
   * null in a process also prints the reason to stderr.
   */
  declineWhenRunFromSource(cacheDir: string | null): string | null;
}

/**
 * Build the code stamp and packs digest for one adapter. `moduleUrl` has
 * to be the calling module's own `import.meta.url`, so the stamp finds
 * the dist file the adapter itself was loaded from rather than some
 * other package's.
 */
export function createAdapterStamp(config: {
  moduleUrl: string;
  version: string;
}): AdapterStamp {
  let cachedCodeStamp: AdapterCodeStamp | null = null;
  let saidWhyNoCache = false;

  function codeStamp(): AdapterCodeStamp {
    if (cachedCodeStamp !== null) {
      return cachedCodeStamp;
    }
    cachedCodeStamp = readAdapterCodeStamp(config.moduleUrl);
    return cachedCodeStamp;
  }

  function packsDigest(
    packVersions: ReadonlyArray<{ name: string; version?: string }>,
  ): string {
    const sortedPacks = [...packVersions]
      .map((p) => `${p.name}@${p.version ?? "unset"}`)
      .sort();
    const stamp = codeStamp();
    const adapterStamp =
      stamp.kind === "bundle"
        ? `adapter@${config.version}+${stamp.hash}`
        : `adapter@${config.version}+source`;
    return `${adapterStamp}|${sortedPacks.join(",")}`;
  }

  function declineWhenRunFromSource(cacheDir: string | null): string | null {
    if (cacheDir === null || codeStamp().kind === "bundle") {
      return cacheDir;
    }
    if (!saidWhyNoCache) {
      saidWhyNoCache = true;
      process.stderr.write(
        "[suss] extraction cache off: this process loaded the adapter from source, where nothing can tell one build of it from another. Run the built adapter to cache.\n",
      );
    }
    return null;
  }

  return { codeStamp, packsDigest, declineWhenRunFromSource };
}

function readAdapterCodeStamp(moduleUrl: string): AdapterCodeStamp {
  try {
    // A published adapter bundles the calling module into its dist entry
    // file, so the directory `moduleUrl` points into contains the bundle.
    const selfPath = fileURLToPath(moduleUrl);
    const hash = computeDistHashFrom(path.dirname(selfPath));
    return hash.length > 0 ? { kind: "bundle", hash } : SOURCE_STAMP;
  } catch {
    return SOURCE_STAMP;
  }
}

/**
 * The hash for a bundle directory: the bundle itself plus every analysis
 * package that can be located. Empty when the directory has no bundle in
 * it, as happens when running from source.
 */
export function computeDistHashFrom(dir: string): string {
  const candidates = [path.join(dir, "index.js"), path.join(dir, "index.cjs")];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    return computeContentHash([candidate, ...analysisBundles()]);
  }
  return "";
}

/**
 * Content hash of the given files, in the order they arrive. Empty when
 * the list is empty or a file cannot be read, so a caller that could not
 * locate a file gets the same "no stamp" result as a run from source
 * rather than a hash of a shorter list.
 *
 * The caller resolves the paths, because where a specifier resolves to
 * depends on which package is asking.
 */
export function computeContentHash(paths: readonly string[]): string {
  if (paths.length === 0) {
    return "";
  }

  const hash = createHash("sha256");
  for (const file of paths) {
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      return "";
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Stamp for a set of project files a run reads without walking them: a
 * SAM template, a workspace package.json. Both the paths and the
 * content go in, so a file that moves counts as a change even when
 * every byte in it stayed the same.
 *
 * A file that cannot be read is hashed as absent, where
 * `computeContentHash` would return an empty stamp. These files belong
 * to the project, so a missing one is a change the next run should see.
 */
export function projectFileStamp(paths: readonly string[]): string {
  if (paths.length === 0) {
    return "none";
  }

  const hash = createHash("sha256");
  for (const file of [...paths].sort()) {
    hash.update(file);
    hash.update("\0");
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update("absent");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * The digest a run looks its cache entry up under. A pack may read
 * project files that are not among the ones a run walks, a SAM template
 * that decides which handlers exist for instance, so those belong in
 * the key next to the pack's own config. Which files they are depends
 * on the files this run walks, so the digest is computed per run rather
 * than once per adapter.
 */
export function runDigest(
  packsDigest: string,
  packs: ReadonlyArray<{
    discoveryInputs?: (files: readonly string[]) => string[];
  }>,
  files: readonly string[],
): string {
  const inputs = packs.flatMap((pack) => pack.discoveryInputs?.(files) ?? []);
  return `${packsDigest}|reads:${projectFileStamp(inputs)}`;
}

/**
 * Where the analysis packages were loaded from. Only consulted once the
 * adapter has found its own bundle, so a run from source keeps the empty
 * stamp and its deterministic keys. A package that cannot be located is
 * skipped rather than failing the hash.
 */
function analysisBundles(): string[] {
  const require = createRequire(import.meta.url);
  const found: string[] = [];
  for (const name of ANALYSIS_PACKAGES) {
    try {
      found.push(require.resolve(name));
    } catch {
      // A host that bundles everything has no separate file to hash,
      // and its own bundle already contains the code.
    }
  }
  return found;
}
