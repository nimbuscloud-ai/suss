// functionCall.ts: an in-process function call as a boundary.
//
// Covers React components, custom-hook boundaries, bare TS function
// exports, and a package's public surface.

import { z } from "zod";

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
   * Package name (as written in `package.json`) when this identity
   * refers to a public package export — e.g. `"@suss/behavioral-ir"`.
   * Set alongside `exportPath` by packs that resolve a package's
   * public surface (the `packageExports` discovery variant). Distinct
   * from `module`, which is a repo-relative module path for
   * intra-repo pairing.
   */
  package: z.string().optional(),
  /**
   * Path to the exported binding within the package, starting with
   * the sub-path key when one is used. Examples:
   *   `["parseSummary"]`              — root export
   *   `["schemas", "BoundaryBindingSchema"]` — sub-path `./schemas`
   *
   * The first segment is the sub-path without the leading `./`
   * (`"."` → omitted). The last segment is the exported name.
   */
  exportPath: z.array(z.string()).optional(),
});

export type FunctionCallSemantics = z.infer<typeof FunctionCallSemanticsSchema>;

export const functionCallSemantics = defineBoundarySemantics({
  name: "function-call",
  schema: FunctionCallSemanticsSchema,
  behavior: {
    /**
     * `"fn:<package>::<exportPath>"` when both are set; other
     * in-process function-call units (intra-repo components, bare
     * handlers) have no key.
     */
    identityKey(semantics) {
      if (
        semantics.package !== undefined &&
        semantics.exportPath !== undefined &&
        semantics.exportPath.length > 0
      ) {
        return `fn:${semantics.package}::${semantics.exportPath.join(".")}`;
      }
      return null;
    },
  },
});
