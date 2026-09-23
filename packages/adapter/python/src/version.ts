/**
 * The Python adapter's part of the extraction cache key.
 *
 * Bump `ADAPTER_VERSION` by hand on any change to what extraction
 * produces, such as the IR it writes, what discovery finds, or how a
 * terminal is classified. Summaries cached under the old version are
 * then read again instead of reused.
 */

import { createAdapterStamp } from "@suss/extractor";

export const ADAPTER_VERSION = "0.1.0";

export const adapterStamp = createAdapterStamp({
  moduleUrl: import.meta.url,
  version: ADAPTER_VERSION,
});
