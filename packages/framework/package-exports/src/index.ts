/**
 * The boundary between packages in one workspace. Each public export is
 * a `library` unit and each function that imports one from a sibling
 * package is a `caller` unit. No library defines which packages exist,
 * so the patterns set `workspaces: true` and the adapter applies them
 * once per package in the workspace manifest.
 *
 * Every positional parameter becomes an input under the name the source
 * gives it, since the workspace's own code is there to read.
 */

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

export function packageExportsFramework(): PatternPack {
  return {
    name: "package-exports",
    languages: ["typescript"],
    protocol: "in-process",

    discovery: [
      {
        kind: "library",
        match: { type: "packageExports", workspaces: true },
      },
      {
        kind: "caller",
        match: { type: "packageImport", workspaces: true },
      },
    ],

    terminals: [
      {
        kind: "return",
        match: { type: "returnStatement" },
        extraction: {},
      },
      {
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    inputMapping: { type: "allPositional" },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-package-exports",
  dependencies: [],
  reads:
    "The boundary between packages in one workspace: public exports on the provider side, and imports of them on the consumer side. The pack reads the workspace manifest, so nobody has to list the packages for each project.",
};

export default packageExportsFramework;
