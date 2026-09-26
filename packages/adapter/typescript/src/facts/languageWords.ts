/**
 * What the language's own library does, said the way a pack says what
 * its library does.
 *
 * `Object.assign(target, ...sources)` hands back `target`, and no file
 * suss reads says so, because the function is part of the runtime. The
 * store adds these words to every run, whatever packs it has. The
 * extractor records a call of a global under `GLOBAL_MODULE` and the
 * global's dotted name, so a project value called `Object` is declared
 * somewhere else and does not match.
 *
 * `f.bind(x)` hands back a function that runs `f`. That word matches on
 * the method's name alone, like a `.bind` a project class declares.
 */

import { GLOBAL_MODULE } from "@suss/resolution";

import type { UnwrapsByName } from "@suss/resolution";

export const LANGUAGE_WRAPPERS: readonly UnwrapsByName[] = [
  { module: GLOBAL_MODULE, name: "Object.assign", argument: 0 },
];

export const LANGUAGE_RECEIVER_RETURNS: readonly string[] = ["bind"];
