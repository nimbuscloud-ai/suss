/**
 * moduleInit.ts: the raw structure for what a module does when it loads.
 *
 * A module's top-level statements run once, when it is first imported,
 * and a service that reads its configuration there reads it there for
 * good. Walking unit bodies alone never sees that read, so the read gets
 * a unit of its own, one per file, named after the file, with no
 * boundary. Attributing it to each handler would report one read as
 * several. The calls those statements make go on the same unit, so the
 * closure can reach the functions behind them.
 *
 * The one default branch has a `void` terminal, because module
 * initialization returns to nobody. Every adapter builds it the same way.
 */

import type { Effect } from "@suss/behavioral-ir";
import type { RawCodeStructure, RawEffect } from "./index.js";

export interface ModuleInitOptions {
  /** The unit name, which is the file's base name in every adapter. */
  name: string;
  file: string;
  range: { start: number; end: number };
  effects: Effect[];
  /** The calls the top-level statements make while the module loads. */
  calls?: RawEffect[];
}

export function moduleInitStructure(
  options: ModuleInitOptions,
): RawCodeStructure {
  const { name, file, range, effects, calls } = options;
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
        effects: calls ?? [],
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
