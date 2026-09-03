/**
 * version.ts: this adapter's own half of the cache key.
 *
 * `ADAPTER_VERSION` is the hand-bumped semver. Bump it on any change
 * that affects extraction output: IR shape, discovery semantics,
 * terminal classification, anything that would invalidate previously
 * cached summaries. `createAdapterStamp` (from `@suss/extractor`) folds
 * it together with a hash of this adapter's own loaded code, so a
 * rebuilt dev build invalidates the cache even when nobody remembered
 * to bump the constant. See that package's README for the full design.
 */

import { createAdapterStamp } from "@suss/extractor";

import type { AdapterCodeStamp } from "@suss/extractor";

export const ADAPTER_VERSION = "0.1.0";

const stamp = createAdapterStamp({
  moduleUrl: import.meta.url,
  version: ADAPTER_VERSION,
});

/**
 * The stamp for the running adapter. Computed once per process, since
 * the files behind it cannot change under a process that has already
 * loaded them.
 */
export function adapterCodeStamp(): AdapterCodeStamp {
  return stamp.codeStamp();
}

/**
 * Compute a cache-friendly identity for an adapter+packs combination.
 *
 * A pack's stamp is whatever the caller that loaded the pack put there.
 * The adapter takes packs as plain objects and cannot tell where one
 * came from, so folding the config and the code into the stamp is the
 * loader's job.
 */
export function computeAdapterPacksDigest(
  packVersions: ReadonlyArray<{ name: string; version?: string }>,
): string {
  return stamp.packsDigest(packVersions);
}

/** `cacheDir` unless this process loaded the adapter from source. */
export function declineWhenRunFromSource(
  cacheDir: string | null,
): string | null {
  return stamp.declineWhenRunFromSource(cacheDir);
}
