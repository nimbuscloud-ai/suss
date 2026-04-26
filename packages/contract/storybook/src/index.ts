// @suss/contract-storybook — generate behavioral summaries from Storybook CSF.
//
// A Storybook story file declares (a) a default export with meta info
// (the `component` being storied) and (b) named exports, each a story
// object whose `args` describe one canonical scenario. For cross-shape
// contract checking, each story is a *specification* of "this component
// supports this prop configuration" (docs/contracts.md). Comparing an
// inferred component summary against its stories answers: does the
// component accept the args every story supplies? Does every inferred
// branch have a story that reaches it?
//
// v0 scope:
//   * Parse `.stories.ts[x]` via ts-morph.
//   * Find the default export and extract `meta.component` (usually an
//     identifier referring to the component under test). Preserve the
//     identifier name — resolving it to a module path is a follow-up
//     when we formalise cross-module component references.
//   * Find each named export and extract `args` as a literal object.
//     Each story produces one `component`-kind BehavioralSummary with
//     the args surfaced as inputs.
//   * Mark `confidence.source = "derived"`, `level = "medium"`. Stories
//     are authored by humans; they're authoritative where they speak
//     but don't enumerate the full behavior space.
//
// Explicitly deferred:
//   * `play` function parsing — capturing the event sequence that
//     exercises an interactive story. Useful for cross-referencing
//     event-handler sub-units once Phase 3 lands.
//   * `argTypes` extraction — per-arg metadata (control type, option
//     list). Informs stricter type checking in later phases.
//   * `decorators` / `parameters` — Storybook-specific runtime
//     plumbing, not behavioral.
//   * CSF1 / MDX stories — CSF3 is the supported format.
//   * Cross-file component resolution — we preserve the meta component
//     identifier but don't follow the import to the component's
//     module. Follow-up when a downstream consumer needs it.

import path from "node:path";

import {
  type Node,
  type ObjectLiteralExpression,
  Project,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";

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
   * Project root — used to compute portable relative paths in each
   * summary's `location.file`. Defaults to the cwd.
   */
  projectRoot?: string;
}

/**
 * Read one or more `.stories.ts[x]` files and emit one
 * BehavioralSummary per named story export.
 */
export function generateSummariesFromStories(
  filePaths: string[],
  options: StorybookStubOptions = {},
): BehavioralSummary[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      target: 99,
      module: 99,
      moduleResolution: 100,
      skipLibCheck: true,
      allowJs: true,
      jsx: 4,
    },
  });
  for (const fp of filePaths) {
    project.addSourceFileAtPath(fp);
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  const summaries: BehavioralSummary[] = [];

  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath();
    const relPath = path.relative(projectRoot, absPath);
    const meta = extractMeta(sf);
    if (meta === null) {
      continue;
    }
    const stories = extractStories(sf);
    for (const story of stories) {
      summaries.push(buildSummary(story, meta, relPath));
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Meta extraction
// ---------------------------------------------------------------------------

interface MetaInfo {
  /** Identifier name of the component being storied (e.g. "Button"). */
  componentName: string;
}

function extractMeta(sf: SourceFile): MetaInfo | null {
  const defaultExport = sf.getDefaultExportSymbol();
  if (defaultExport === undefined) {
    return null;
  }

  // The default export is commonly a `const meta = { component: X };
  // export default meta;` pattern, a direct `export default { ... }`,
  // or `export default satisfies Meta<typeof X>`. Walk the symbol's
  // declarations looking for an object-literal with a `component`
  // property whose value is an identifier.
  for (const decl of defaultExport.getDeclarations()) {
    const objLit = findMetaObjectLiteral(decl);
    if (objLit === null) {
      continue;
    }
    const componentProp = objLit.getProperty("component");
    if (componentProp === undefined) {
      continue;
    }
    if (!componentProp.isKind(SyntaxKind.PropertyAssignment)) {
      continue;
    }
    const initializer = componentProp.getInitializer();
    if (initializer === undefined) {
      continue;
    }
    // Commonly an identifier (`component: Button`). Record its name.
    return { componentName: initializer.getText() };
  }

  return null;
}

function findMetaObjectLiteral(node: Node): ObjectLiteralExpression | null {
  if (node.isKind(SyntaxKind.ExportAssignment)) {
    return unwrapToObjectLiteral(node.getExpression());
  }
  // `const meta = { ... }; export default meta;` — the default-export
  // symbol's declaration is the VariableDeclaration itself.
  if (node.isKind(SyntaxKind.VariableDeclaration)) {
    const init = node.getInitializer();
    return init === undefined ? null : unwrapToObjectLiteral(init);
  }
  return null;
}

/**
 * Follow `satisfies` wrappers, parens, and identifier references (to
 * local variable declarations) to reach an object literal. Returns
 * null when the expression doesn't resolve to one statically.
 */
function unwrapToObjectLiteral(node: Node): ObjectLiteralExpression | null {
  if (node.isKind(SyntaxKind.ObjectLiteralExpression)) {
    return node;
  }
  if (node.isKind(SyntaxKind.SatisfiesExpression)) {
    return unwrapToObjectLiteral(node.getExpression());
  }
  if (node.isKind(SyntaxKind.ParenthesizedExpression)) {
    return unwrapToObjectLiteral(node.getExpression());
  }
  if (node.isKind(SyntaxKind.AsExpression)) {
    return unwrapToObjectLiteral(node.getExpression());
  }
  if (node.isKind(SyntaxKind.Identifier)) {
    const sym = node.getSymbol();
    if (sym === undefined) {
      return null;
    }
    for (const d of sym.getDeclarations()) {
      if (d.isKind(SyntaxKind.VariableDeclaration)) {
        const init = d.getInitializer();
        if (init !== undefined) {
          const unwrapped = unwrapToObjectLiteral(init);
          if (unwrapped !== null) {
            return unwrapped;
          }
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Story extraction
// ---------------------------------------------------------------------------

interface StoryInfo {
  name: string;
  args: Record<string, string>;
  line: number;
}

function extractStories(sf: SourceFile): StoryInfo[] {
  const results: StoryInfo[] = [];

  // CSF3: each named export is a `const Name: Story = { args: { ... } }`.
  // We don't type-check the `Story` annotation — just look at the
  // shape.
  for (const [name, decls] of sf.getExportedDeclarations()) {
    if (name === "default") {
      continue;
    }
    for (const decl of decls) {
      if (!decl.isKind(SyntaxKind.VariableDeclaration)) {
        continue;
      }
      const init = decl.getInitializer();
      if (init === undefined) {
        continue;
      }
      const objLit = unwrapToObjectLiteral(init);
      if (objLit === null) {
        continue;
      }

      const argsProp = objLit.getProperty("args");
      const args: Record<string, string> = {};
      if (argsProp?.isKind(SyntaxKind.PropertyAssignment)) {
        const argsInit = argsProp.getInitializer();
        if (argsInit?.isKind(SyntaxKind.ObjectLiteralExpression)) {
          for (const prop of argsInit.getProperties()) {
            if (prop.isKind(SyntaxKind.PropertyAssignment)) {
              const value = prop.getInitializer();
              if (value !== undefined) {
                args[prop.getName()] = value.getText();
              }
            } else if (prop.isKind(SyntaxKind.ShorthandPropertyAssignment)) {
              args[prop.getName()] = prop.getName();
            }
          }
        }
      }

      results.push({
        name,
        args,
        line: decl.getStartLineNumber(),
      });
    }
  }

  return results;
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
    // Args are authored literals; record the source text in the shape's
    // `ref.name` so consumers can see the concrete value. Promoting
    // this to a structured literal shape is a follow-up (would need to
    // parse each arg's source into a TypeShape; for v0 we surface the
    // text).
    shape: { type: "ref", name: value } as TypeShape,
  }));

  // Single default transition: "this story renders the component."
  // v0 doesn't simulate the render; the transition carries the
  // component identity as the render output's `component` field and
  // leaves `root` unset. Later work can populate `root` by evaluating
  // the inferred render tree against the story's args.
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
          args: story.args,
          provenance: "independent",
        },
      },
    },
  };
}
