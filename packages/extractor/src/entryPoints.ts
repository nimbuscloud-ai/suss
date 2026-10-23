/**
 * Functions a deploy manifest says the platform calls, as a pack finds
 * them for one source file. A Lambda's `Handler` is one: the template
 * says which file and which function, and nothing in the code calls it.
 *
 * The pack reads the manifest, which is the library's business, and
 * decides which units the function gets. The adapter finds the
 * definition by `name`, which is a language rule, and builds each unit
 * on it, so the call walk starts there. Python and Ruby take packs as
 * data and use this shape; a TypeScript pack has `discoverUnits` and
 * finds the function itself.
 */

import type {
  BoundaryBinding,
  CodeUnitKind,
  DeployableUnit,
} from "@suss/behavioral-ir";

export interface DeclaredEntryPoint {
  /**
   * The function as the manifest writes it, in the language's own
   * spelling: `handler` for a function at the top of the file, or
   * `Billing::Handler.process` for a Ruby class method.
   */
  name: string;
  /** The units to build on that function. One function can be several deployed units. */
  units: DeclaredEntryUnit[];
}

export interface DeclaredEntryUnit {
  kind: CodeUnitKind;
  /** The summary's name. */
  name: string;
  binding: BoundaryBinding;
  deployableUnit: DeployableUnit;
  /** Merged onto the summary's `metadata`. */
  metadata?: Record<string, unknown>;
}
