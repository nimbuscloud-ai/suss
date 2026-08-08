// dogfoodOutputs.mjs
//
// Where a dogfood run puts what it produces. Two scripts have to agree
// about these: dogfood.mjs writes them, and checkDogfoodBaseline.mjs
// reads the baseline back. The per-package location serves a second
// reason to live here, which is that it has to stay somewhere npm will
// not pick up, and a second spelling of it elsewhere would be how that
// quietly stops being true.

import path from "node:path";

import { ROOT } from "./workspacePackages.mjs";

/**
 * A dogfood run writes each package's own summaries to
 * `<pkg>/.suss/suss-summaries.json`. That directory already contains the
 * adapter's extraction cache, so it is already gitignored and already
 * outside every manifest's `files`. Writing into `dist/` instead put the
 * file inside what npm ships, and since nothing reads it back, being in
 * the build output bought nothing.
 */
export const SUMMARIES_DIR = ".suss";
export const SUMMARIES_FILE = "suss-summaries.json";

/** Repo-relative path of the committed count-of-what-suss-saw baseline. */
export const BASELINE_REL_PATH = "scripts/dogfood-baseline.json";

export const BASELINE_PATH = path.join(ROOT, BASELINE_REL_PATH);
