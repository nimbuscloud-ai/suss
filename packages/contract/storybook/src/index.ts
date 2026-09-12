// @suss/contract-storybook: generate behavioral summaries from Storybook CSF.
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
//     identifier name: resolving it to a module path is a follow-up
//     when we formalise cross-module component references.
//   * Find each named export and extract `args` as a literal object.
//     Each story produces one `component`-kind BehavioralSummary with
//     the args surfaced as inputs.
//   * Mark `confidence.source = "derived"`, `level = "medium"`. Stories
//     are authored by humans; they're authoritative where they speak
//     but don't enumerate the full behavior space.
//
// Explicitly deferred:
//   * `play` function parsing, capturing the event sequence that
//     exercises an interactive story. Useful for cross-referencing
//     event-handler sub-units once Phase 3 lands.
//   * `argTypes` extraction: per-arg metadata (control type, option
//     list). Informs stricter type checking in later phases.
//   * `decorators` / `parameters`, Storybook-specific runtime
//     plumbing, not behavioral.
//   * CSF1 / MDX stories, CSF3 is the supported format.
//   * Cross-file component resolution. We preserve the meta component
//     identifier but don't follow the import to the component's
//     module. Follow-up when a downstream consumer needs it.

import path from "node:path";

import {
  Node as N,
  type Node,
  type ObjectLiteralExpression,
  Project,
  type SourceFile,
} from "ts-morph";

import {
  exportedDeclarationsOf,
  objectLiteralOf,
  propertiesOf,
  propertyNameOf,
  propertyOf,
  propertyValueOf,
  ResolutionStore,
  stringValueOf,
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
   * Project root: used to compute portable relative paths in each
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
  const resolution = new ResolutionStore();

  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath();
    const relPath = path.relative(projectRoot, absPath);
    const meta = extractMeta(sf, resolution);
    if (meta === null) {
      continue;
    }
    const stories = extractStories(sf, resolution);
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

function extractMeta(
  sf: SourceFile,
  resolution: ResolutionStore,
): MetaInfo | null {
  for (const exported of resolution.exportsOf(sf).get("default") ?? []) {
    const meta = objectBehind(exported, resolution);
    if (meta === null) {
      continue;
    }
    // Commonly an identifier (`component: Button`). Record its name.
    const component = propertyOf(meta, "component", resolution);
    if (component !== null) {
      return { componentName: component.getText() };
    }
  }

  return null;
}

/** The object a declaration or an expression comes down to. */
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
): StoryInfo[] {
  const results: StoryInfo[] = [];

  // CSF3: each named export is a `const Name: Story = { args: { ... } }`.
  // We don't type-check the `Story` annotation, just look at the
  // shape.
  for (const [name, decls] of exportedDeclarationsOf(sf, resolution)) {
    if (name === "default") {
      continue;
    }
    for (const decl of decls) {
      const story = objectBehind(decl, resolution);
      if (story === null) {
        continue;
      }

      results.push({
        name,
        args: storyArgs(story, resolution),
        line: decl.getStartLineNumber(),
      });
    }
  }

  return results;
}

/**
 * What a story hands its component, one entry per arg. A string comes
 * back as the string, so a name and a template read the same as a
 * quoted literal. Anything the evaluator does not settle to a string,
 * a number, a JSX element or an object among them, keeps its source
 * text, which is all a reader can be given for it.
 */
function storyArgs(
  story: ObjectLiteralExpression,
  resolution: ResolutionStore,
): Record<string, string> {
  const args: Record<string, string> = {};
  const written = propertyOf(story, "args", resolution);
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
    // Args are authored literals; record the source text in the shape's
    // `ref.name` so consumers can see the concrete value. Promoting
    // this to a structured literal shape is a follow-up (would need to
    // parse each arg's source into a TypeShape; for v0 we surface the
    // text).
    shape: { type: "ref", name: value } as TypeShape,
  }));

  // Single default transition: "this story renders the component."
  // v0 doesn't simulate the render; the transition records the
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
