// packageShape.ts: a package's exported functions, and the package that
// calls them.
//
// The boundary here is the one the dogfood run exercises and no
// generator reached: what a package publishes is a contract, and every
// call site in another package is bound to it. Both sides are generated
// together, since a provider nobody calls and a call nobody provides
// each only test half of the pairing.
//
// The package manifest is read off disk, and its resolution is memoized
// per path for the life of the process, so each way of publishing gets
// its own directory rather than rewriting one manifest in place.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type DispatchTable, dispatchByType } from "../dispatch.js";

export type PublishRoute =
  | "namedFunction"
  | "exportedArrow"
  | "reexportedFromModule"
  | "renamedExport"
  | "starReexport"
  | "subPathExport"
  | "mainOnly";

export type ImportForm =
  | "namedImport"
  | "aliasedImport"
  | "namespaceImport"
  | "throughLocalBinding"
  | "reexportedByConsumer";

export interface PackageShapeSpec {
  route: PublishRoute;
  form: ImportForm;
}

export const SIMPLEST_PACKAGE_SHAPE: PackageShapeSpec = {
  route: "namedFunction",
  form: "namedImport",
};

export const PACKAGE_NAME = "@generated/provider";
const EXPORT_NAME = "alpha";

export const packageProjectRoot = (): string =>
  path.join(os.tmpdir(), `suss-differential-package-${process.pid}`);

const IMPLEMENTATION = [
  `export function ${EXPORT_NAME}(count: number) {`,
  "  if (count < 0) {",
  '    throw new Error("count must not be negative");',
  "  }",
  "  return { count };",
  "}",
  "",
].join("\n");

const IMPLEMENTATION_UNDER = (localName: string): string =>
  IMPLEMENTATION.replace(`function ${EXPORT_NAME}(`, `function ${localName}(`);

interface ProviderRendering {
  /** Relative path to content, under the provider directory. */
  files: Record<string, string>;
  packageJson: Record<string, unknown>;
  /** The export path the binding should have. */
  exportPath: string[];
  /** The sub-path a caller imports from. */
  importSpecifier: string;
}

const rootExports = (target: string): Record<string, unknown> => ({
  name: PACKAGE_NAME,
  version: "0.0.0",
  type: "module",
  exports: { ".": { types: target } },
});

const providerRenderings: DispatchTable<
  { type: PublishRoute },
  ProviderRendering
> = {
  namedFunction: () => ({
    files: { "src/index.ts": IMPLEMENTATION },
    packageJson: rootExports("./dist/index.d.ts"),
    exportPath: [EXPORT_NAME],
    importSpecifier: PACKAGE_NAME,
  }),
  exportedArrow: () => ({
    files: {
      "src/index.ts": [
        `export const ${EXPORT_NAME} = (count: number) => {`,
        "  if (count < 0) {",
        '    throw new Error("count must not be negative");',
        "  }",
        "  return { count };",
        "};",
        "",
      ].join("\n"),
    },
    packageJson: rootExports("./dist/index.d.ts"),
    exportPath: [EXPORT_NAME],
    importSpecifier: PACKAGE_NAME,
  }),
  reexportedFromModule: () => ({
    files: {
      "src/implementation.ts": IMPLEMENTATION,
      "src/index.ts": `export { ${EXPORT_NAME} } from "./implementation.js";\n`,
    },
    packageJson: rootExports("./dist/index.d.ts"),
    exportPath: [EXPORT_NAME],
    importSpecifier: PACKAGE_NAME,
  }),
  renamedExport: () => ({
    files: {
      "src/implementation.ts": IMPLEMENTATION_UNDER("implementation"),
      "src/index.ts": `export { implementation as ${EXPORT_NAME} } from "./implementation.js";\n`,
    },
    packageJson: rootExports("./dist/index.d.ts"),
    exportPath: [EXPORT_NAME],
    importSpecifier: PACKAGE_NAME,
  }),
  starReexport: () => ({
    files: {
      "src/implementation.ts": IMPLEMENTATION,
      "src/index.ts": 'export * from "./implementation.js";\n',
    },
    packageJson: rootExports("./dist/index.d.ts"),
    exportPath: [EXPORT_NAME],
    importSpecifier: PACKAGE_NAME,
  }),
  // A second entry point, which is how a package publishes something
  // its root does not export.
  subPathExport: () => ({
    files: {
      "src/index.ts": "export const version = 1;\n",
      "src/extra.ts": IMPLEMENTATION,
    },
    packageJson: {
      name: PACKAGE_NAME,
      version: "0.0.0",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts" },
        "./extra": { types: "./dist/extra.d.ts" },
      },
    },
    exportPath: ["extra", EXPORT_NAME],
    importSpecifier: `${PACKAGE_NAME}/extra`,
  }),
  // A package with no `exports` field at all, which is most of what
  // was published before subpath exports existed.
  mainOnly: () => ({
    files: { "src/index.ts": IMPLEMENTATION },
    packageJson: {
      name: PACKAGE_NAME,
      version: "0.0.0",
      type: "module",
      types: "./dist/index.d.ts",
      main: "./dist/index.js",
    },
    exportPath: [EXPORT_NAME],
    importSpecifier: PACKAGE_NAME,
  }),
};

/** The consumer file, which always calls the function from a function. */
function consumerSource(spec: PackageShapeSpec, specifier: string): string {
  const table: DispatchTable<{ type: ImportForm }, string[]> = {
    namedImport: () => [
      `import { ${EXPORT_NAME} } from ${JSON.stringify(specifier)};`,
      "",
      "export function run(count: number) {",
      `  return ${EXPORT_NAME}(count);`,
      "}",
    ],
    aliasedImport: () => [
      `import { ${EXPORT_NAME} as fromProvider } from ${JSON.stringify(specifier)};`,
      "",
      "export function run(count: number) {",
      "  return fromProvider(count);",
      "}",
    ],
    namespaceImport: () => [
      `import * as provider from ${JSON.stringify(specifier)};`,
      "",
      "export function run(count: number) {",
      `  return provider.${EXPORT_NAME}(count);`,
      "}",
    ],
    throughLocalBinding: () => [
      `import { ${EXPORT_NAME} } from ${JSON.stringify(specifier)};`,
      "",
      `const call = ${EXPORT_NAME};`,
      "",
      "export function run(count: number) {",
      "  return call(count);",
      "}",
    ],
    reexportedByConsumer: () => [
      `import { ${EXPORT_NAME} } from ${JSON.stringify(specifier)};`,
      "",
      `export { ${EXPORT_NAME} };`,
      "",
      "export function run(count: number) {",
      `  return ${EXPORT_NAME}(count);`,
      "}",
    ],
  };
  return `${dispatchByType(table, { type: spec.form }).join("\n")}\n`;
}

export interface RenderedPackageShape {
  /** Absolute path to content, for every file the program spans. */
  files: Record<string, string>;
  /** Absolute path to the manifest the provider side is read through. */
  packageJsonPath: string;
  /** What the provider's binding should say. */
  exportPath: string[];
  /** The module specifier the consumer side is tracked through. */
  importSpecifier: string;
  root: string;
}

export function renderPackageShape(
  spec: PackageShapeSpec,
): RenderedPackageShape {
  const provider = dispatchByType(providerRenderings, { type: spec.route });
  // One directory per way of publishing: the manifest behind a path is
  // read once per process, so two manifests cannot share a path.
  const root = path.join(packageProjectRoot(), spec.route);
  const providerDir = path.join(root, "provider");

  const files: Record<string, string> = {
    [path.join(providerDir, "package.json")]:
      `${JSON.stringify(provider.packageJson, null, 2)}\n`,
    [path.join(root, "consumer", "src", "app.ts")]: consumerSource(
      spec,
      provider.importSpecifier,
    ),
  };
  for (const [relative, content] of Object.entries(provider.files)) {
    files[path.join(providerDir, relative)] = content;
  }

  return {
    files,
    packageJsonPath: path.join(providerDir, "package.json"),
    exportPath: provider.exportPath,
    importSpecifier: provider.importSpecifier,
    root,
  };
}

export function writePackageShape(rendered: RenderedPackageShape): void {
  for (const [filePath, content] of Object.entries(rendered.files)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}
