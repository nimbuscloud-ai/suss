/**
 * Checks the props a parent passes to a component it renders.
 *
 * A render-tree element with a `target` says which component the parent
 * renders and which attrs it passes. The child's `inputReads`, with the
 * reads its handlers and effects make of its props, say which props it uses.
 * TypeScript already rejects a missing required prop or an unknown extra
 * one, so this pass reports only a prop that arrives and is never read.
 * It skips an edge whenever the read set could be incomplete: no
 * `inputReads`, or props forwarded whole. `key`, `ref` and `children`
 * never count, and `css` counts as read when the child reads `className`.
 */

import {
  functionCallBinding,
  readReactMetadata,
  renderTargetKey,
  summaryRef,
} from "@suss/behavioral-ir";

import { readSetOf } from "../receive/inputContract.js";

import type {
  BehavioralSummary,
  Finding,
  RenderNode,
} from "@suss/behavioral-ir";

const PLUMBING = new Set(["key", "ref", "children"]);

/**
 * Props a JSX runtime turns into another prop before the child sees them.
 * Emotion and styled-components compile `css` into a `className`, so a
 * child that reads `className` gets the styles.
 */
const FOLDED_INTO: Readonly<Record<string, string>> = { css: "className" };

function usedOrFolded(name: string, used: ReadonlySet<string>): boolean {
  const folded = FOLDED_INTO[name];
  return used.has(name) || (folded !== undefined && used.has(folded));
}

interface RenderEdge {
  parent: BehavioralSummary;
  tag: string;
  target: { file: string; name: string };
  attrNames: string[];
}

function edgesOf(summary: BehavioralSummary): RenderEdge[] {
  const edges: RenderEdge[] = [];
  const walk = (node: RenderNode): void => {
    if (node.type === "conditional") {
      walk(node.whenTrue);
      if (node.whenFalse !== null) {
        walk(node.whenFalse);
      }
      return;
    }
    if (node.type !== "element") {
      return;
    }
    if (node.target !== undefined) {
      edges.push({
        parent: summary,
        tag: node.tag,
        target: node.target,
        attrNames: Object.keys(node.attrs ?? {}).filter(
          (name) => !name.startsWith("..."),
        ),
      });
    }
    for (const child of node.children) {
      walk(child);
    }
  };

  for (const transition of summary.transitions) {
    if (transition.output.type === "render" && transition.output.root) {
      walk(transition.output.root);
    }
  }
  return edges;
}

/**
 * The prop names a child reads. A prop name is the first segment of a
 * read path. Null when the read set could be incomplete, so the caller
 * reports nothing instead of judging a partial list.
 */
function propsUsedBy(
  child: BehavioralSummary,
  subUnits: readonly BehavioralSummary[],
): Set<string> | null {
  const result = readSetOf(
    { ...child, inputReads: componentReads(child, subUnits) },
    (input) => input.type === "parameter" && input.role === "props",
  );
  if (!result.read) {
    return null;
  }
  return new Set(result.reads.paths.map((path) => path[0]));
}

type InputRead = NonNullable<BehavioralSummary["inputReads"]>[number];

/**
 * The component's own reads, and the reads its handlers and effects make
 * of the component's parameters. A sub-unit's summary records those under
 * the component's parameter names, beside reads of its own parameters,
 * so a name the sub-unit also declares is left out.
 */
function componentReads(
  child: BehavioralSummary,
  subUnits: readonly BehavioralSummary[],
): InputRead[] {
  const childParameters = parameterNames(child);
  const fromSubUnits = subUnits.flatMap((subUnit) => {
    const own = parameterNames(subUnit);
    return (subUnit.inputReads ?? []).filter(
      (read) => childParameters.has(read.input) && !own.has(read.input),
    );
  });
  return [...(child.inputReads ?? []), ...fromSubUnits];
}

function parameterNames(summary: BehavioralSummary): Set<string> {
  return new Set(
    summary.inputs.flatMap((input) =>
      input.type === "parameter" ? [input.name] : [],
    ),
  );
}

/**
 * The units declared inside a component. Its handlers and effects say
 * which component they belong to. Any other callback written in its
 * body, such as the function a data hook calls, is found by where it is.
 */
function subUnitsFinder(
  summaries: readonly BehavioralSummary[],
): (component: BehavioralSummary) => BehavioralSummary[] {
  const fileOf = (summary: BehavioralSummary): string =>
    `${summary.location.workspace ?? ""}\u0000${summary.location.file}`;
  const byFile = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    const key = fileOf(summary);
    const inFile = byFile.get(key);
    if (inFile === undefined) {
      byFile.set(key, [summary]);
      continue;
    }

    inFile.push(summary);
  }
  return (component) =>
    (byFile.get(fileOf(component)) ?? []).filter(
      (summary) =>
        summary !== component &&
        (readReactMetadata(summary)?.component === component.identity.name ||
          declaredInside(summary, component)),
    );
}

function declaredInside(
  inner: BehavioralSummary,
  outer: BehavioralSummary,
): boolean {
  const within = inner.location.span;
  const around = outer.location.span;
  if (within === undefined || around === undefined) {
    return false;
  }
  return (
    around.start <= within.start &&
    within.end <= around.end &&
    within.end - within.start < around.end - around.start
  );
}

export function checkRenderProps(summaries: BehavioralSummary[]): Finding[] {
  const findings: Finding[] = [];
  const subUnitsOf = subUnitsFinder(summaries);
  const childByKey = new Map<string, BehavioralSummary>();
  for (const summary of summaries) {
    const { workspace, file } = summary.location;
    childByKey.set(
      renderTargetKey(workspace, file, summary.identity.name),
      summary,
    );
    const exported = summary.identity.exportPath?.join(".");
    if (exported !== undefined && exported.length > 0) {
      childByKey.set(renderTargetKey(workspace, file, exported), summary);
    }
  }

  for (const summary of summaries) {
    for (const edge of edgesOf(summary)) {
      // A target's file is written from the root of the parent's own
      // extract, so it is a file in the parent's workspace.
      const child = childByKey.get(
        renderTargetKey(
          summary.location.workspace,
          edge.target.file,
          edge.target.name,
        ),
      );
      if (child === undefined || child === summary) {
        continue;
      }
      // Only a component's inputs are spelled as props. Any other kind
      // keeps the parameter's own spelling, so its reads say nothing
      // about which prop was used.
      const used =
        child.kind === "component"
          ? propsUsedBy(child, subUnitsOf(child))
          : null;
      if (used === null) {
        continue;
      }

      for (const name of edge.attrNames) {
        if (PLUMBING.has(name) || usedOrFolded(name, used)) {
          continue;
        }
        findings.push({
          kind: "boundaryFieldUnused",
          boundary:
            child.identity.boundaryBinding ??
            functionCallBinding({
              transport: "in-process",
              recognition: "render-edge",
            }),
          provider: {
            summary: summaryRef(child),
            location: child.location,
          },
          consumer: {
            summary: summaryRef(summary),
            location: summary.location,
          },
          description: `${summary.identity.name} passes "${name}" to ${edge.target.name}, and nothing in ${edge.target.name} reads it.`,
          severity: "info",
          aspect: "receive",
        });
      }
    }
  }
  return findings;
}
