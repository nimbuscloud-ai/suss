// dogfoodOutputs.mjs
//
// Where a dogfood run puts what it produces. The writer is the only
// script that needs this today, but the location is the whole point of
// the module: it has to stay somewhere npm will not pick up, and a
// second spelling of it elsewhere would be how that quietly stops being
// true.

/**
 * A dogfood run writes each package's own summaries to
 * `<pkg>/.suss/suss-summaries.json`. That directory already holds the
 * adapter's extraction cache, so it is already gitignored and already
 * outside every manifest's `files`. Writing into `dist/` instead put the
 * file inside what npm ships, and since nothing reads it back, being in
 * the build output bought nothing.
 */
export const SUMMARIES_DIR = ".suss";
export const SUMMARIES_FILE = "suss-summaries.json";
