// version.ts: adapter version stamp, used as an input to cache keys.
//
// `ADAPTER_VERSION` is the hand-bumped semver. Bump it on any change
// that affects extraction output: IR shape, discovery semantics,
// terminal classification, anything that would invalidate previously-
// cached summaries.
//
// During development, manual bumps are easy to forget: every src
// change rebuilds dist, but the cache still hits stale entries because
// the version constant didn't change. To avoid that footgun the cache
// key also mixes in a hash of the loaded dist file. In production
// (running from published `dist/index.js`), the hash is stable per
// release. In dev (rebuilt dist), the hash changes on every rebuild
// and invalidates the cache automatically.
//
// The hash covers every package the analysis runs through, not only
// this one. The extractor turns what the adapter reads into summaries
// and the resolution rules decide what an export comes down to, and
// both ship separately, so a release that changed only one of them
// would otherwise keep serving the summaries the previous one produced.
//
// Under vitest, ts-node or tsx there is no bundle beside this module,
// so nothing here can find the adapter's own code and the stamp says
// "source" instead of a hash. A run in that mode does not cache:
// otherwise every edit to the adapter would be invisible to the key and
// the previous run's results would come back unchanged.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ADAPTER_VERSION = "0.2.1";

/**
 * Packages whose behaviour affects what an extraction produces. The
 * dist files import @suss/datalog and @suss/behavioral-ir rather than
 * bundling them, so leaving either out of the hash serves stale
 * summaries after a change to it (#236).
 */
const ANALYSIS_PACKAGES = [
  "@suss/extractor",
  "@suss/resolution",
  "@suss/datalog",
  "@suss/behavioral-ir",
];

/**
 * Whether this process can see the adapter's own code. `bundle` includes
 * a hash that changes whenever the code does. `source` means nothing
 * here could find it, so a cache key built from this stamp says nothing
 * about the code that will produce the results.
 */
export type AdapterCodeStamp =
  | { kind: "bundle"; hash: string }
  | { kind: "source" };

const SOURCE_STAMP: AdapterCodeStamp = { kind: "source" };

let cachedCodeStamp: AdapterCodeStamp | null = null;

/**
 * The stamp for the running adapter. Computed once per process, since
 * the files behind it cannot change under a process that has already
 * loaded them.
 */
export function adapterCodeStamp(): AdapterCodeStamp {
  if (cachedCodeStamp !== null) {
    return cachedCodeStamp;
  }
  cachedCodeStamp = readAdapterCodeStamp();
  return cachedCodeStamp;
}

function readAdapterCodeStamp(): AdapterCodeStamp {
  try {
    // At runtime under ESM, `import.meta.url` points at this module's
    // file. In a published package that's `dist/index.js` (tsup bundles
    // version.ts into the same file). Hash that file.
    const selfPath = fileURLToPath(import.meta.url);
    const hash = computeDistHashFrom(path.dirname(selfPath));
    return hash.length > 0 ? { kind: "bundle", hash } : SOURCE_STAMP;
  } catch {
    return SOURCE_STAMP;
  }
}

/**
 * The hash for a bundle directory: the bundle itself plus every analysis
 * package that can be located. Empty when the directory has no bundle in
 * it, which is what running from source looks like.
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
 * A file that cannot be read stamps as absent rather than voiding the
 * whole stamp, which is what `computeContentHash` does. These files
 * belong to the project rather than to the installed tool: one of them
 * being gone is a fact about the project the next run should notice,
 * not a reason to stop telling runs apart.
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

/**
 * Compute a cache-friendly identity for an adapter+packs combination.
 * Stable across processes given the same inputs; bumps when any pack
 * arrives with a new version stamp, the adapter version changes, or the
 * loaded adapter dist file changes (dev-mode rebuild auto-invalidation).
 *
 * A pack's stamp is whatever the caller that loaded the pack put there.
 * The adapter takes packs as plain objects and cannot tell where one
 * came from, so folding the config and the code into the stamp is the
 * loader's job.
 *
 * A source run says as much in the digest rather than leaving the
 * adapter out of it. Nothing writes under that digest today, and a key
 * that says "source" cannot be mistaken for one built from the code.
 */
export function computeAdapterPacksDigest(
  packVersions: ReadonlyArray<{ name: string; version?: string }>,
): string {
  const sortedPacks = [...packVersions]
    .map((p) => `${p.name}@${p.version ?? "unset"}`)
    .sort();
  const stamp = adapterCodeStamp();
  const adapterStamp =
    stamp.kind === "bundle"
      ? `adapter@${ADAPTER_VERSION}+${stamp.hash}`
      : `adapter@${ADAPTER_VERSION}+source`;
  return `${adapterStamp}|${sortedPacks.join(",")}`;
}
