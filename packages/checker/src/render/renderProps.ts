/**
 * Checks the props a parent passes to a component it renders.
 *
 * A render-tree element with a `target` says which component the parent
 * renders and which attrs it passes, and the child's `inputReads` say
 * which props it uses. TypeScript already rejects a missing required
 * prop or an unknown extra one, so this pass reports only a prop that
 * arrives and is never read. It skips an edge whenever the read set
 * could be incomplete: no `inputReads`, props forwarded whole, or a
 * nested unit such as a handler. `key`, `ref` and `children` never count.
 */

import {
  functionCallBinding,
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
function propsUsedBy(child: BehavioralSummary): Set<string> | null {
  const result = readSetOf(
    child,
    (input) => input.type === "parameter" && input.role === "props",
  );
  if (!result.read) {
    return null;
  }
  return new Set(result.reads.paths.map((path) => path[0]));
}

/**
 * The summaries declared inside another one, by file. A handler, an
 * effect or an inner function gets a summary of its own, and a prop it
 * uses from the enclosing component is recorded on neither summary, so
 * a component with any of them has a read set with holes in it.
 */
function nestedUnitsIndex(
  summaries: BehavioralSummary[],
): (outer: BehavioralSummary) => boolean {
  const byFile = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    const inFile = byFile.get(summary.location.file) ?? [];
    inFile.push(summary);
    byFile.set(summary.location.file, inFile);
  }
  const known = new Map<BehavioralSummary, boolean>();
  return (outer) => {
    const cached = known.get(outer);
    if (cached !== undefined) {
      return cached;
    }

    const nested = (byFile.get(outer.location.file) ?? []).some(
      (inner) => inner !== outer && declaredInside(inner, outer),
    );
    known.set(outer, nested);
    return nested;
  };
}

function declaredInside(
  inner: BehavioralSummary,
  outer: BehavioralSummary,
): boolean {
  const innerSpan = inner.location.span;
  const outerSpan = outer.location.span;
  if (innerSpan !== undefined && outerSpan !== undefined) {
    return (
      outerSpan.start <= innerSpan.start &&
      innerSpan.end <= outerSpan.end &&
      innerSpan.end - innerSpan.start < outerSpan.end - outerSpan.start
    );
  }

  const innerLines = inner.location.range;
  const outerLines = outer.location.range;
  return (
    outerLines.start <= innerLines.start &&
    innerLines.end <= outerLines.end &&
    innerLines.end - innerLines.start < outerLines.end - outerLines.start
  );
}

export function checkRenderProps(summaries: BehavioralSummary[]): Finding[] {
  const findings: Finding[] = [];
  const hasNestedUnits = nestedUnitsIndex(summaries);
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
        child.kind !== "component" || hasNestedUnits(child)
          ? null
          : propsUsedBy(child);
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
