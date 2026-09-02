/**
 * moduleInit.ts: the raw structure for what a module does when it loads.
 *
 * A module's top-level statements run once, when it is first imported,
 * and a service that reads its configuration there reads it there for
 * good. Walking unit bodies alone never sees that read, so the read gets
 * a unit of its own, one per file, named after the file, with no
 * boundary. Attributing it to each handler in the file would report one
 * read as several, and a file with no handler would still report nothing.
 *
 * The structure is one default branch whose terminal is `void`, because
 * module initialization returns to nobody. Every adapter builds it the
 * same way, so it lives here.
 */

import type { Effect } from "@suss/behavioral-ir";
import type { RawCodeStructure } from "./index.js";

export interface ModuleInitOptions {
  /** The unit name, which is the file's base name in every adapter. */
  name: string;
  file: string;
  range: { start: number; end: number };
  effects: Effect[];
}

export function moduleInitStructure(
  options: ModuleInitOptions,
): RawCodeStructure {
  const { name, file, range, effects } = options;
  return {
    identity: {
      name,
      kind: "module-init",
      file,
      range,
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: null,
    parameters: [],
    branches: [
      {
        conditions: [],
        terminal: {
          kind: "void",
          statusCode: null,
          body: null,
          exceptionType: null,
          message: null,
          component: null,
          renderTree: null,
          delegateTarget: null,
          emitEvent: null,
          location: range,
        },
        effects: [],
        extraEffects: effects,
        location: range,
        isDefault: true,
      },
    ],
    unmatchedReturns: 0,
    dependencyCalls: [],
    declaredContract: null,
  };
}
