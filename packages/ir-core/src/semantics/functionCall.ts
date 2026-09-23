/**
 * An in-process function call as a boundary.
 *
 * This covers React components, exported functions and a package's
 * public surface. A package export gets an identity key, because two
 * repositories can both refer to its name. An in-repo unit that gives
 * its module and export name, such as a server action, gets one too.
 * Components and plain handlers give neither and pair through call
 * edges.
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
  // A call inside the process does not produce a span, and the
  // conventions have no attributes for it.
  semconv: {},
  behavior: {
    /** A call returns a value, with no status. */
    exchangesHttpResponses: false,
    leavesTheProcess: false,
    reportsUnpairedItself: false,
    /**
     * In-repo units such as components have no key on purpose. They
     * pair through call edges instead of the keyed pass, so a missing
     * key does not make them unreachable.
     */
    canPair: () => true,
    rewritePaths(semantics, rewrite) {
      if (semantics.module === undefined) {
        return semantics;
      }
      return { ...semantics, module: rewrite(semantics.module) };
    },
    /**
     * `"fn:<package>::<exportPath>"` when both are set, and
     * `"fn:<module>::<exportName>"` for an in-repo unit that gives its
     * module, as a server action does. Components and plain handlers
     * give neither and have no key.
     */
    identityKey(semantics) {
      if (
        semantics.package !== undefined &&
        semantics.exportPath !== undefined &&
        semantics.exportPath.length > 0
      ) {
        return fnIdentityKey(semantics.package, semantics.exportPath);
      }
      if (
        semantics.module !== undefined &&
        semantics.exportName !== undefined
      ) {
        return fnIdentityKey(semantics.module, [semantics.exportName]);
      }
      return null;
    },
  },
});
