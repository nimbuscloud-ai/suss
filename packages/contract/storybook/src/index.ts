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
  /** The `component` identifier as written, such as `Button`. */
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
    // Usually an identifier. Its text is kept and the import is never
    // followed.
    const component = propertyOf(meta, "component", resolution);
    if (component !== null) {
      return { componentName: component.getText() };
    }
  }

  return null;
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
 * An arg that evaluates to a string gives that string, so a constant or a
 * template gives the same value as a quoted literal. Anything else, such
 * as a number or JSX, keeps its source text.
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
          args: story.args,
          provenance: "independent",
        },
      },
    },
  };
}
