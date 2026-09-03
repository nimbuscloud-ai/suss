/**
 * version.ts: this adapter's own half of the cache key.
 *
 * `ADAPTER_VERSION` is the hand-bumped semver. Bump it on any change
 * that affects extraction output: IR shape, discovery semantics,
 * terminal classification, anything that would invalidate previously
 * cached summaries.
 */

import { createAdapterStamp } from "@suss/extractor";

export const ADAPTER_VERSION = "0.1.0";

export const adapterStamp = createAdapterStamp({
  moduleUrl: import.meta.url,
  version: ADAPTER_VERSION,
});
