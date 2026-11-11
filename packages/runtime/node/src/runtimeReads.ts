/**
 * Reads of what Node gives a program without an import, declared as read
 * chains: the environment off `process.env` and `import.meta.env`, the
 * rest of `process`, `import.meta`, and the module globals `__dirname`
 * and `__filename`. A config read pairs against whatever declares the
 * variable, and a metadata read records that the unit depends on the
 * runtime without being paired. The README has the spellings each covers.
 */

import { compile, global, runtimeReads } from "@suss/recognize";

import { RECOGNITION } from "./configBinding.js";

import type { AccessRecognizer } from "@suss/extractor";
import type { Deployment, EntryMeaning, Match } from "@suss/recognize";

const CONFIG: EntryMeaning = { reads: "config" };
const META: EntryMeaning = { reads: "metadata" };
const NOTHING: EntryMeaning = { reads: "nothing" };

/**
 * A key Vite sets on `import.meta.env` from the build itself: the mode,
 * the base URL, and whether the build is for production, development or
 * the server. No deployment declares one, so a read of it is a metadata
 * read, named as the dotted read however it was spelled.
 */
const VITE: EntryMeaning = { reads: "metadata", callee: "dotted" };

/**
 * The objects whose properties are the environment, as the code spells
 * them. Node gives a program `process.env`. Vite and Bun give it
 * `import.meta.env`, which a program reads the same way.
 */
export const ENVIRONMENT_OBJECTS: readonly string[] = [
  "process.env",
  "import.meta.env",
];

/**
 * The read chains, in the order their effects are recorded at one node.
 * The two environment chains are separate because a Vite key is metadata
 * off `import.meta.env` and config off `process.env`, and a read through
 * a helper is named after the object its first site reads.
 */
export function runtimeReadMatches(deployment: Deployment): {
  environment: Match[];
  rest: Match[];
} {
  const processEnv = runtimeReads({
    object: global("process.env"),
    deployment,
  })
    .entries({}, CONFIG)
    .throughHelpers()
    .example('process.env.TABLE_NAME ?? "accounts"');

  const importMetaEnv = runtimeReads({
    object: global("import.meta.env"),
    deployment,
  })
    .entries(
      { MODE: VITE, BASE_URL: VITE, PROD: VITE, DEV: VITE, SSR: VITE },
      CONFIG,
    )
    .throughHelpers()
    .example("import.meta.env.VITE_API_URL");

  // `process.argv` is a config read like a variable's, named `argv`
  // whatever is read off it, and the rest of what `process` says about
  // itself is metadata.
  const processReads = runtimeReads({
    object: global("process"),
    deployment,
  })
    .entries({
      argv: { reads: "config", named: "argv", callee: "site" },
      cwd: META,
      platform: META,
      version: META,
      versions: META,
      pid: META,
      ppid: META,
      arch: META,
      execPath: META,
      execArgv: META,
    })
    .writes({ exitCode: { changes: "state" } })
    .example("process.argv.slice(2)");

  const importMeta = runtimeReads({ object: global("import.meta") })
    .entries({ env: NOTHING }, META)
    .example("import.meta.url");

  const fileLocation = runtimeReads({
    object: global("__dirname", "__filename"),
  })
    .entries({}, { reads: "metadata", callee: "object" })
    .example("__dirname.length");

  return {
    environment: [processEnv, importMetaEnv],
    rest: [processReads, importMeta, fileLocation],
  };
}

/** The declared reads, as the hooks the adapter calls on its access walk. */
export function compiledReads(matches: readonly Match[]): AccessRecognizer[] {
  return matches.map((match) => compile(match.declared, RECOGNITION));
}
