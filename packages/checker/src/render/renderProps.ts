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
 * never count.
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

/** Each component's handlers and effects, by the component they are declared in. */
function subUnitsByComponent(
  summaries: readonly BehavioralSummary[],
): Map<string, BehavioralSummary[]> {
  const byComponent = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    const component = readReactMetadata(summary)?.component;
    if (component === undefined) {
      continue;
    }
    const key = renderTargetKey(summary.location.file, component);
    byComponent.set(key, [...(byComponent.get(key) ?? []), summary]);
  }
  return byComponent;
}

export function checkRenderProps(summaries: BehavioralSummary[]): Finding[] {
  const findings: Finding[] = [];
  const subUnitsOf = subUnitsByComponent(summaries);
  const childByKey = new Map<string, BehavioralSummary>();
  for (const summary of summaries) {
    const file = summary.location.file;
    childByKey.set(renderTargetKey(file, summary.identity.name), summary);
    const exported = summary.identity.exportPath?.join(".");
    if (exported !== undefined && exported.length > 0) {
      childByKey.set(renderTargetKey(file, exported), summary);
    }
  }

  for (const summary of summaries) {
    for (const edge of edgesOf(summary)) {
      const child = childByKey.get(
        renderTargetKey(edge.target.file, edge.target.name),
      );
      if (child === undefined || child === summary) {
        continue;
      }
      // Only a component's inputs are spelled as props. Any other kind
      // keeps the parameter's own spelling, so its reads say nothing
      // about which prop was used.
      const used =
        child.kind === "component"
          ? propsUsedBy(
              child,
              subUnitsOf.get(
                renderTargetKey(child.location.file, child.identity.name),
              ) ?? [],
            )
          : null;
      if (used === null) {
        continue;
      }

      for (const name of edge.attrNames) {
        if (PLUMBING.has(name) || used.has(name)) {
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
