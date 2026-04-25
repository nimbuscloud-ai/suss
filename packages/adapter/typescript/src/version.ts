// version.ts — adapter version stamp, used as an input to cache keys.
//
// Bump on any change that affects extraction output — IR shape,
// discovery semantics, terminal classification, anything that would
// invalidate previously-cached summaries. The cache layer combines
// this with each pack's `version` to form the per-summary digest;
// any change here invalidates every cached entry across every pack.
//
// Kept as a module-scope constant rather than read from package.json
// so cache keys round-trip through tests and ad-hoc tooling without
// requiring fs access.

export const ADAPTER_VERSION = "0.1.0";

/**
 * Compute a cache-friendly identity for an adapter+packs combination.
 * Stable across processes given the same inputs; bumps when any pack
 * declares a new version or the adapter version changes.
 */
export function computeAdapterPacksDigest(
  packVersions: ReadonlyArray<{ name: string; version?: string }>,
): string {
  const sortedPacks = [...packVersions]
    .map((p) => `${p.name}@${p.version ?? "unset"}`)
    .sort();
  return `adapter@${ADAPTER_VERSION}|${sortedPacks.join(",")}`;
}
