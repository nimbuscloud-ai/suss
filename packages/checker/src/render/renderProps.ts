/**
 * The props check across render edges.
 *
 * A render-tree element with a `target` says which component a parent
 * renders and what it passes (the attrs); the child's `inputReads`
 * say what it uses. TypeScript already rejects a missing required
 * prop and an unknown extra one at compile time, so those findings
 * would be noise. What it does not say is that a prop arrives and is
 * never read, which is the one finding this pass emits. The pass
 * skips an edge whenever the read set could be incomplete: the child
 * recorded nothing under `inputReads`, or it uses a props object
 * whole (forwarding). React's own plumbing props (`key`, `ref`,
 * `children`) are never reported.
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
 * The prop names a child observably uses. A prop is one segment deep,
 * so the outermost segment of each read path is the whole answer. Null
 * when the read set could be incomplete, and the caller reports
 * nothing rather than judging a partial list.
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

export function checkRenderProps(summaries: BehavioralSummary[]): Finding[] {
  const findings: Finding[] = [];
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
      const used = propsUsedBy(child);
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
