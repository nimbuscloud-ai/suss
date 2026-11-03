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
  type ParameterDeclaration,
  Project,
  SyntaxKind,
} from "ts-morph";

import {
  declarationsBehind,
  exportedValuesOf,
  findNearestTsconfig,
  projectPlaceOf,
  ResolutionStore,
  symbolBehind,
  toFunctionRoot,
} from "@suss/adapter-typescript";
import { functionCallBinding } from "@suss/behavioral-ir";
import { defaultProjectRoot, pathInProject } from "@suss/behavioral-ir/files";

import type { ExportedValue } from "@suss/adapter-typescript";
import type {
  BehavioralSummary,
  BoundaryBinding,
  Input,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type { ValueOps } from "@suss/recognize";
import type { AstCapableValueOps } from "@suss/recognize/ast";

export interface StorybookStubOptions {
  /**
   * Each summary's `location.file` is relative to this, so it is the same
   * on every machine. Defaults to the repository each story is in.
   */
  projectRoot?: string;
  /**
   * False leaves out `componentModule`, the file each component is
   * declared in. Finding it means reading the story under its tsconfig,
   * whose path aliases make the type checker load most of the app, so a
   * caller that only asks whether a file has stories passes false.
   */
  componentModules?: boolean;
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
  const componentModules = options.componentModules ?? true;
  const byFile = new Map<string, BehavioralSummary[]>();
  const groups: Map<string | null, string[]> = componentModules
    ? filesByTsconfig(filePaths)
    : new Map([[null, filePaths]]);

  for (const [tsconfig, files] of groups) {
    const project = projectFor(tsconfig);
    const resolution = new ResolutionStore();
    for (const sf of files.map((fp) => project.addSourceFileAtPath(fp))) {
      const storyFile = sf.getFilePath();
      const relPath = pathInProject(
        storyFile,
        options.projectRoot ?? defaultProjectRoot(storyFile),
      );
      const exported = exportedValuesOf(sf, resolution);
      const meta = extractMeta(exported, componentModules);
      if (meta === null) {
        continue;
      }
      byFile.set(
        sf.getFilePath(),
        extractStories(exported, meta).map((story) =>
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
  argReaders: ArgReader[];
  /** What the meta's render function passes the component, from `renderPropsOf`. */
  renderProps: string[] | null;
}

/**
 * The parts of a story or its meta that receive the story's args before
 * the component does. The reader does not follow either, so it cannot say
 * which args reach the component.
 */
const ARG_READERS = ["decorators", "render"] as const;
type ArgReader = (typeof ARG_READERS)[number];

function argReadersOf(storyOrMeta: ValueOps): ArgReader[] {
  const keys = new Set(
    storyOrMeta.entries("nothing").map((entry) => entry.key),
  );
  return ARG_READERS.filter((name) => keys.has(name));
}

/**
 * The props a `render` function passes the story's component by name,
 * besides the args it spreads in. Null when that cannot be said: there
 * is no render function, it cannot be read, it never renders the
 * component's element itself, or it spreads something other than its
 * args into it.
 */
function renderPropsOf(
  storyOrMeta: ValueOps,
  componentName: string,
): string[] | null {
  const found = storyOrMeta.property("render")?.function?.() ?? null;
  const render = found === null ? null : toFunctionRoot(nodeBehind(found));
  if (render === null) {
    return null;
  }
  const argNames = argNamesOf(render.getParameters()[0]);
  const elements = [
    ...render.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...render.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ].filter((element) => element.getTagNameNode().getText() === componentName);
  if (elements.length === 0) {
    return null;
  }
  const passed = new Set<string>();
  if (elements.some(hasJsxChildren)) {
    passed.add("children");
  }
  for (const attribute of elements.flatMap((e) => e.getAttributes())) {
    if (N.isJsxAttribute(attribute)) {
      passed.add(attribute.getNameNode().getText());
      continue;
    }
    if (!argNames.has(attribute.getExpression().getText())) {
      return null;
    }
  }
  return [...passed].sort();
}

/** Whether anything between the element's tags reaches it as `children`. */
function hasJsxChildren(element: Node): boolean {
  const parent = element.getParent();
  if (!N.isJsxOpeningElement(element) || !N.isJsxElement(parent)) {
    return false;
  }
  return parent
    .getJsxChildren()
    .some(
      (child) => !(N.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces()),
    );
}

/**
 * What a render function's first parameter calls the args, or the rest
 * of them after a destructure. Spreading one of these passes the
 * component only args the story already lists.
 */
function argNamesOf(parameter: ParameterDeclaration | undefined): Set<string> {
  const names = new Set<string>();
  const nameNode = parameter?.getNameNode();
  if (nameNode === undefined) {
    return names;
  }
  if (N.isIdentifier(nameNode)) {
    names.add(nameNode.getText());
    return names;
  }
  const elements = N.isObjectBindingPattern(nameNode)
    ? nameNode
        .getDescendantsOfKind(SyntaxKind.BindingElement)
        .filter((element) => element.getParent() === nameNode)
    : [];
  for (const element of elements) {
    if (element.getDotDotDotToken() !== undefined) {
      names.add(element.getName());
    }
  }
  return names;
}

interface ComponentModule {
  workspace?: string;
  file: string;
  name: string;
}

function extractMeta(
  exported: Map<string, ExportedValue[]>,
  componentModules: boolean,
): MetaInfo | null {
  for (const { value } of exported.get("default") ?? []) {
    const meta = value.object?.() ?? null;
    const component = meta?.property("component") ?? null;
    if (meta === null || component === null) {
      continue;
    }
    const componentName = textOf(component);
    return {
      componentName,
      componentModule: componentModules
        ? declaredModuleOf(nodeBehind(component))
        : undefined,
      componentImport: component.importedFrom?.() ?? undefined,
      args: argsOf(meta),
      argReaders: argReadersOf(meta),
      renderProps: renderPropsOf(meta, componentName),
    };
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
  const place = projectPlaceOf(declaration.getSourceFile().getFilePath());
  return {
    ...(place.workspace === null ? {} : { workspace: place.workspace }),
    file: place.file,
    name: declaredNameOf(declaration) ?? component.getText(),
  };
}

/** An import whose module did not resolve leaves only the import itself. */
function componentDeclarationOf(component: Identifier): Node | undefined {
  return declarationsBehind(symbolBehind(component)).find(
    (declaration) => !isImportBinding(declaration),
  );
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

/**
 * The node a value was read at, for the two reads the value ops cannot
 * make yet: the component's declaration, which takes the type checker,
 * and the JSX a render function returns, which the facts do not state.
 */
function nodeBehind(value: ValueOps): Node {
  return (value as AstCapableValueOps).ast() as Node;
}

/** The value as the story file writes it. */
function textOf(value: ValueOps): string {
  return value.source?.() ?? nodeBehind(value).getText();
}

// ---------------------------------------------------------------------------
// Story extraction
// ---------------------------------------------------------------------------

interface StoryInfo {
  name: string;
  args: Record<string, string>;
  argReaders: ArgReader[];
  renderProps: string[] | null;
  line: number;
}

function extractStories(
  exported: Map<string, ExportedValue[]>,
  meta: MetaInfo,
): StoryInfo[] {
  const results: StoryInfo[] = [];

  // Any named export that resolves to an object literal counts as a story.
  // The `Story` type annotation is never checked.
  for (const [name, values] of exported) {
    if (name === "default") {
      continue;
    }
    for (const { value, line } of values) {
      const story = value.object?.() ?? null;
      if (story === null) {
        continue;
      }

      // A story's own arg, or its own render function, replaces the meta's.
      const ownReaders = argReadersOf(story);
      results.push({
        name,
        args: { ...meta.args, ...argsOf(story) },
        argReaders: ARG_READERS.filter(
          (reader) =>
            meta.argReaders.includes(reader) || ownReaders.includes(reader),
        ),
        renderProps: ownReaders.includes("render")
          ? renderPropsOf(story, meta.componentName)
          : meta.renderProps,
        line,
      });
    }
  }

  return results;
}

/**
 * The `args` of a story or of the meta. An arg that evaluates to a string
 * gives that string, so a constant or a template gives the same value as
 * a quoted literal. Anything else, such as a number, JSX or a method,
 * keeps its source text.
 */
function argsOf(storyOrMeta: ValueOps): Record<string, string> {
  const args: Record<string, string> = {};
  const object = storyOrMeta.property("args")?.object?.() ?? null;
  for (const { key, value } of object?.entries("nothing") ?? []) {
    if (key === null) {
      continue;
    }
    const settled = value.evaluated?.() ?? null;
    args[key] = typeof settled === "string" ? settled : textOf(value);
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
          ...(story.argReaders.length === 0
            ? {}
            : { argReaders: story.argReaders }),
          ...(story.renderProps === null
            ? {}
            : { renderProps: story.renderProps }),
          provenance: "independent",
        },
      },
    },
  };
}
