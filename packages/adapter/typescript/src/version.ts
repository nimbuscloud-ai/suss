// version.ts — adapter version stamp, used as an input to cache keys.
//
// `ADAPTER_VERSION` is the hand-bumped semver. Bump it on any change
// that affects extraction output — IR shape, discovery semantics,
// terminal classification, anything that would invalidate previously-
// cached summaries.
//
// During development, manual bumps are easy to forget — every src
// change rebuilds dist, but the cache still hits stale entries because
// the version constant didn't change. To avoid that footgun the cache
// key also mixes in a hash of the loaded dist file. In production
// (running from published `dist/index.js`), the hash is stable per
// release. In dev (rebuilt dist), the hash changes on every rebuild
// and invalidates the cache automatically.
//
// Tests run from src (no dist sibling); the hash falls through to an
// empty string, so test-time cache keys stay deterministic across
// runs.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ADAPTER_VERSION = "0.1.0";

let cachedDistHash: string | null = null;

function computeDistHash(): string {
  if (cachedDistHash !== null) {
    return cachedDistHash;
  }
  try {
    // At runtime under ESM, `import.meta.url` points at this module's
    // file. In a published package that's `dist/index.js` (tsup bundles
    // version.ts into the same file). Hash that file.
    //
    // In ts-node / vitest the URL points at `src/version.ts`; the
    // sibling `index.js` does not exist, so we fall through to the
    // empty stamp. Test-time cache keys stay stable across processes.
    const selfPath = fileURLToPath(import.meta.url);
    const dir = path.dirname(selfPath);
    const candidates = [
      path.join(dir, "index.js"),
      path.join(dir, "index.cjs"),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const content = fs.readFileSync(candidate);
      cachedDistHash = createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, 16);
      return cachedDistHash;
    }
    cachedDistHash = "";
    return cachedDistHash;
  } catch {
    cachedDistHash = "";
    return cachedDistHash;
  }
}

/**
 * Compute a cache-friendly identity for an adapter+packs combination.
 * Stable across processes given the same inputs; bumps when any pack
 * declares a new version, the adapter version changes, or the loaded
 * adapter dist file changes (dev-mode rebuild auto-invalidation).
 */
export function computeAdapterPacksDigest(
  packVersions: ReadonlyArray<{ name: string; version?: string }>,
): string {
  const sortedPacks = [...packVersions]
    .map((p) => `${p.name}@${p.version ?? "unset"}`)
    .sort();
  const distHash = computeDistHash();
  const adapterStamp =
    distHash.length > 0
      ? `adapter@${ADAPTER_VERSION}+${distHash}`
      : `adapter@${ADAPTER_VERSION}`;
  return `${adapterStamp}|${sortedPacks.join(",")}`;
}
