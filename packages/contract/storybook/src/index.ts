/**
 * Reads Storybook CSF3 story files into one component summary per story.
 * A story is a hand-written claim that its component supports one set of
 * props. Comparing stories with the component's inferred summary shows
 * whether the component accepts every story's args, and whether each
 * inferred branch has a story that reaches it.
 *
 * Confidence is `medium`, because a story is accurate about what it covers
 * but stories never list everything a component does. The README lists
 * what the reader leaves out.
 */

import path from "node:path";

import {
  type Identifier,
  Node as N,
  type Node,
  type ObjectLiteralExpression,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

import {
  exportedDeclarationsOf,
  findNearestTsconfig,
  objectLiteralOf,
  propertiesOf,
  propertyNameOf,
  propertyOf,
  propertyValueOf,
  ResolutionStore,
  resolveAliasedSymbol,
  stringValueOf,
  symbolBehind,
  workspaceNameFor,
  workspaceRootFor,
} from "@suss/adapter-typescript";
import { functionCallBinding } from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  BoundaryBinding,
  Input,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";

export interface StorybookStubOptions {
  /**
   * Each summary's `location.file` is relative to this, so it is the same
   * on every machine. Defaults to the working directory.
   */
  projectRoot?: string;
}

/**
 * Reads `.stories.ts` and `.stories.tsx` files and returns one summary per
 * named story export. A file whose default export has no `component` is
 * skipped.
 */
export function generateSummariesFromStories(
  filePaths: string[],
  options: StorybookStubOptions = {},
): BehavioralSummary[] {
  const projectRoot = options.projectRoot ?? process.cwd();
  const byFile = new Map<string, BehavioralSummary[]>();

  for (const [tsconfig, files] of filesByTsconfig(filePaths)) {
    const project = projectFor(tsconfig);
    const resolution = new ResolutionStore();
    for (const sf of files.map((fp) => project.addSourceFileAtPath(fp))) {
      const relPath = path.relative(projectRoot, sf.getFilePath());
      const meta = extractMeta(sf, resolution);
      if (meta === null) {
        continue;
      }
      byFile.set(
        sf.getFilePath(),
        extractStories(sf, resolution, meta.args).map((story) =>
          buildSummary(story, meta, relPath),
        ),
      );
    }
  }

  return filePaths.flatMap(
    (fp) => byFile.get(path.resolve(fp).replace(/\\/g, "/")) ?? [],
  );
}

/**
 * Story files grouped by the tsconfig nearest each one. A story imports
 * its component through the path aliases that tsconfig declares, so the
 * import only resolves under it.
 */
function filesByTsconfig(filePaths: string[]): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  for (const fp of filePaths) {
    const tsconfig = findNearestTsconfig(path.dirname(fp));
    const group = groups.get(tsconfig) ?? [];
    group.push(fp);
    groups.set(tsconfig, group);
  }
  return groups;
}

const COMPILER_OPTIONS = {
  target: 99,
  module: 99,
  moduleResolution: 100,
  skipLibCheck: true,
  allowJs: true,
  jsx: 4,
  // Ambient types say nothing about a story, and a missing types folder
  // makes every program build fail.
  types: [],
};

function projectFor(tsconfig: string | null): Project {
  if (tsconfig !== null) {
    try {
      return new Project({
        tsConfigFilePath: tsconfig,
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true, jsx: 4, types: [] },
      });
    } catch {
      // A tsconfig that does not parse leaves the defaults below, which
      // still follow a relative import.
    }
  }
  return new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: COMPILER_OPTIONS,
  });
}

// ---------------------------------------------------------------------------
// Meta extraction
// ---------------------------------------------------------------------------

interface MetaInfo {
  /** The `component` identifier as written, such as `Button`. */
  componentName: string;
  componentModule: ComponentModule | undefined;
  componentImport: string | undefined;
  /** Args on the default export, which Storybook gives every story in the file. */
  args: Record<string, string>;
}

interface ComponentModule {
  workspace?: string;
  file: string;
  name: string;
}

function extractMeta(
  sf: SourceFile,
  resolution: ResolutionStore,
): MetaInfo | null {
  for (const exported of resolution.exportsOf(sf).get("default") ?? []) {
    const meta = objectBehind(exported, resolution);
    if (meta === null) {
      continue;
    }
    const component = propertyOf(meta, "component", resolution);
    if (component !== null) {
      return {
        componentName: component.getText(),
        componentModule: declaredModuleOf(component),
        componentImport: importSpecifierOf(component),
        args: argsOf(meta, resolution),
      };
    }
  }

  return null;
}

/**
 * The file and name the component is declared under, followed through
 * imports and re-exports. The file is spelled from the root an extract of
 * that file's project measures from, so the two can be compared.
 */
function declaredModuleOf(component: Node): ComponentModule | undefined {
  if (!N.isIdentifier(component)) {
    return undefined;
  }
  const declaration = componentDeclarationOf(component);
  if (declaration === undefined) {
    return undefined;
  }
  const file = declaration.getSourceFile().getFilePath();
  const tsconfig = findNearestTsconfig(path.dirname(file));
  const root = workspaceRootFor(
    tsconfig === null ? path.dirname(file) : path.dirname(tsconfig),
  );
  const workspace = workspaceNameFor(root);
  return {
    ...(workspace === null ? {} : { workspace }),
    file: path.relative(root, file).replace(/\\/g, "/"),
    name: declaredNameOf(declaration) ?? component.getText(),
  };
}

function componentDeclarationOf(component: Identifier): Node | undefined {
  const symbol = symbolBehind(component);
  if (symbol === undefined) {
    return undefined;
  }
  const target = symbol.isAlias() ? resolveAliasedSymbol(symbol) : symbol;
  // An import whose module did not resolve lands on a symbol with no
  // declarations, or on the import itself.
  return target
    ?.getDeclarations()
    .find((declaration) => !isImportBinding(declaration));
}

function isImportBinding(node: Node): boolean {
  return (
    N.isImportSpecifier(node) ||
    N.isImportClause(node) ||
    N.isNamespaceImport(node) ||
    N.isImportEqualsDeclaration(node)
  );
}

function declaredNameOf(declaration: Node): string | undefined {
  if (
    N.isVariableDeclaration(declaration) ||
    N.isFunctionDeclaration(declaration) ||
    N.isClassDeclaration(declaration)
  ) {
    return declaration.getName();
  }
  return undefined;
}

/** The module the story file imports the component from, as written. */
function importSpecifierOf(component: Node): string | undefined {
  if (!N.isIdentifier(component)) {
    return undefined;
  }
  for (const declaration of symbolBehind(component)?.getDeclarations() ?? []) {
    const imported = declaration.getFirstAncestorByKind(
      SyntaxKind.ImportDeclaration,
    );
    if (imported !== undefined) {
      return imported.getModuleSpecifierValue();
    }
  }
  return undefined;
}

/** The object literal a declaration or expression resolves to, or null. */
function objectBehind(
  value: Node,
  resolution: ResolutionStore,
): ObjectLiteralExpression | null {
  const resolved = resolution.resolveObject(value);
  return resolved !== null && N.isObjectLiteralExpression(resolved)
    ? resolved
    : null;
}

// ---------------------------------------------------------------------------
// Story extraction
// ---------------------------------------------------------------------------

interface StoryInfo {
  name: string;
  args: Record<string, string>;
  line: number;
}

function extractStories(
  sf: SourceFile,
  resolution: ResolutionStore,
  metaArgs: Record<string, string>,
): StoryInfo[] {
  const results: StoryInfo[] = [];

  // Any named export that resolves to an object literal counts as a story.
  // The `Story` type annotation is never checked.
  for (const [name, decls] of exportedDeclarationsOf(sf, resolution)) {
    if (name === "default") {
      continue;
    }
    for (const decl of decls) {
      const story = objectBehind(decl, resolution);
      if (story === null) {
        continue;
      }

      // A story's own arg replaces the one of the same name on the meta.
      results.push({
        name,
        args: { ...metaArgs, ...argsOf(story, resolution) },
        line: decl.getStartLineNumber(),
      });
    }
  }

  return results;
}

/**
 * The `args` of a story or of the meta. An arg that evaluates to a string
 * gives that string, so a constant or a template gives the same value as
 * a quoted literal. Anything else, such as a number or JSX, keeps its
 * source text.
 */
function argsOf(
  storyOrMeta: ObjectLiteralExpression,
  resolution: ResolutionStore,
): Record<string, string> {
  const args: Record<string, string> = {};
  const written = propertyOf(storyOrMeta, "args", resolution);
  const object = written === null ? null : objectLiteralOf(written, resolution);
  if (object === null) {
    return args;
  }
  for (const property of propertiesOf(object, resolution)) {
    const name = propertyNameOf(property);
    const value = propertyValueOf(property);
    if (name === null || value === null) {
      continue;
    }
    args[name] = stringValueOf(value, resolution) ?? value.getText();
  }
  return args;
}

// ---------------------------------------------------------------------------
// Summary construction
// ---------------------------------------------------------------------------

function buildSummary(
  story: StoryInfo,
  meta: MetaInfo,
  filePath: string,
): BehavioralSummary {
  const inputs: Input[] = Object.entries(story.args).map(([name, value]) => ({
    type: "parameter",
    name,
    position: 0,
    role: name,
    // The arg's value goes in `ref.name` so a reader can see what the
    // story passes. It is never parsed into a structured TypeShape.
    shape: { type: "ref", name: value } as TypeShape,
  }));

  // The render is not evaluated, so the output records which component
  // renders and leaves `root` unset.
  const transition: Transition = {
    id: `${meta.componentName}-${story.name}`,
    conditions: [],
    output: { type: "render", component: meta.componentName },
    effects: [],
    location: { start: story.line, end: story.line },
    isDefault: true,
  };

  const boundaryBinding: BoundaryBinding = functionCallBinding({
    transport: "in-process",
    recognition: "react",
    exportName: meta.componentName,
  });

  return {
    kind: "component",
    location: {
      file: filePath,
      range: { start: story.line, end: story.line },
      exportName: story.name,
    },
    identity: {
      name: `${meta.componentName}.${story.name}`,
      exportPath: [story.name],
      boundaryBinding,
    },
    inputs,
    transitions: [transition],
    gaps: [],
    confidence: { source: "derived", level: "medium" },
    metadata: {
      component: {
        storybook: {
          story: story.name,
          component: meta.componentName,
          ...(meta.componentModule === undefined
            ? {}
            : { componentModule: meta.componentModule }),
          ...(meta.componentImport === undefined
            ? {}
            : { componentImport: meta.componentImport }),
          args: story.args,
          provenance: "independent",
        },
      },
    },
  };
}
