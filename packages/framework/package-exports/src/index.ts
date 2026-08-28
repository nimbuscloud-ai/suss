/**
 * @suss/framework-package-exports: the PatternPack for the boundary
 * between packages in one workspace.
 *
 * A workspace package's public API is whatever its package.json makes
 * reachable, and every import of it from a sibling package is a use of
 * that contract. The pack marks both sides: one `library` unit per
 * public export, one `caller` unit per importing function. Which
 * packages exist belongs to the project, not to any library, so the
 * patterns say `workspaces: true` and the adapter reads the workspace
 * manifest (npm, yarn, or pnpm) and applies them once per package.
 * Every positional parameter becomes an input under its own declared
 * name, which the workspace's source spells out.
 */

import type { PatternPack } from "@suss/extractor";

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

export default packageExportsFramework;
