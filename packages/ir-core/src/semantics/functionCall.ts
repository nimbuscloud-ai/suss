/**
 * An in-process function call as a boundary.
 *
 * This covers React components, custom-hook boundaries, bare TypeScript
 * function exports, and a package's public surface. Only a package
 * export gets an identity key, because it is the only one of those with
 * a name that two repositories can both refer to.
 */

import { z } from "zod";

import { fnIdentityKey } from "../identityKeys.js";
import { defineBoundarySemantics } from "./definition.js";

export const FunctionCallSemanticsSchema = z.object({
  name: z.literal("function-call"),
  /**
   * Optional module identifier for cross-unit references
   * (e.g. `"./components/Button"` for a React component, or the TS
   * module path for a bare function export). Packs that don't do
   * cross-module pairing can leave it unset.
   */
  module: z.string().optional(),
  /** Named export within the module, when applicable. */
  exportName: z.string().optional(),
  /**
   * Package name, as written in `package.json`, when this identity
   * refers to a public package export, for example
   * `"@suss/behavioral-ir"`. Packs that resolve a package's public
   * surface (the `packageExports` discovery variant) set it alongside
   * `exportPath`. It is different from `module`, which is a
   * repo-relative module path used for pairing inside one repo.
   */
  package: z.string().optional(),
  /**
   * Path to the exported binding within the package, starting with the
   * sub-path key when one is used. Examples:
   *   `["parseSummary"]`: a root export
   *   `["schemas", "BoundaryBindingSchema"]`: the sub-path `./schemas`
   *
   * The first segment is the sub-path without the leading `./`, and
   * `"."` is left out. The last segment is the exported name.
   */
  exportPath: z.array(z.string()).optional(),
});

export type FunctionCallSemantics = z.infer<typeof FunctionCallSemanticsSchema>;

export const functionCallSemantics = defineBoundarySemantics({
  name: "function-call",
  schema: FunctionCallSemanticsSchema,
  behavior: {
    /** A call returns a value, which is not a status and a body. */
    exchangesHttpResponses: false,
    reportsUnpairedItself: false,
    /**
     * In-repo units (components, bare handlers) are keyless by design
     * and pair through call edges rather than the keyed pass, so a
     * missing key is not a boundary nothing can reach.
     */
    canPair: () => true,
    /**
     * `"fn:<package>::<exportPath>"` when both are set. Other in-process
     * function-call units, such as components and bare handlers inside
     * one repo, have no key at all.
     */
    identityKey(semantics) {
      if (
        semantics.package !== undefined &&
        semantics.exportPath !== undefined &&
        semantics.exportPath.length > 0
      ) {
        return fnIdentityKey(semantics.package, semantics.exportPath);
      }
      return null;
    },
  },
});
