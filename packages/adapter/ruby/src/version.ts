/**
 * The adapter's part of the cache key. Bump `ADAPTER_VERSION` by hand on
 * any change to extraction output, such as a change to the IR, to which
 * units are discovered, or to how a terminal is classified. A summary
 * cached under the old version is then thrown away.
 */

import { createAdapterStamp } from "@suss/extractor";

export const ADAPTER_VERSION = "0.1.0";

export const adapterStamp = createAdapterStamp({
  moduleUrl: import.meta.url,
  version: ADAPTER_VERSION,
});
