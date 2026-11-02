/**
 * Every recognizer a pack test runs is run a second time over
 * `callOpsFor`, which reads ts-morph nodes, while the test itself runs
 * over the ops the adapter hands a pack, which read the facts. A
 * difference fails the test unless knownDifferences.ts lists it with a
 * reason. The second run uses the test's own store, which a test may
 * have set up beyond what a fresh one knows. `SUSS_OPS_GATE=report.jsonl`
 * writes every difference to that file instead of failing.
 */

import fs from "node:fs";

import { Node } from "ts-morph";

import { callOpsFor, type ResolutionStore } from "@suss/adapter-typescript";

import { isKnownDifference } from "./knownDifferences.js";

import type { Effect } from "@suss/behavioral-ir";
import type { CallOps, PatternPack } from "@suss/extractor";

type Recognizer = (node: Node, ctx: unknown) => Effect[] | null;

/** One call where the two ops gave a recognizer different effects. */
export interface OpsDifference {
  readonly pack: string;
  readonly call: string;
  readonly fromNodes: string;
  readonly fromFacts: string;
}

/** The comparison for one run of a pack over one file. */
export class OpsGate {
  constructor(
    private readonly pack: PatternPack,
    private readonly store: ResolutionStore,
    private readonly originatesFrom: (value: Node, module: string) => boolean,
  ) {}

  /** Run `recognizer` over the node ops and compare with what it gave over the fact ops. */
  compare(
    recognizer: Recognizer,
    node: Node,
    ctx: object,
    fromFacts: Effect[] | null,
  ): void {
    let fromNodes: Effect[] | null;
    try {
      fromNodes = recognizer(node, { ...ctx, ops: this.nodeOps(node) });
    } catch (error) {
      fromNodes = [{ thrown: String(error) } as unknown as Effect];
    }
    const nodes = JSON.stringify(fromNodes ?? []);
    const facts = JSON.stringify(fromFacts ?? []);
    if (nodes === facts) {
      return;
    }
    const difference: OpsDifference = {
      pack: this.pack.name,
      call: node.getText().slice(0, 200),
      fromNodes: nodes,
      fromFacts: facts,
    };
    if (isKnownDifference(difference)) {
      return;
    }
    const report = process.env.SUSS_OPS_GATE;
    if (report !== undefined && report !== "") {
      fs.appendFileSync(report, `${JSON.stringify(difference)}\n`);
      return;
    }
    throw new Error(
      `The ops over the facts gave ${this.pack.name} a different answer at ${difference.call}.\n  from nodes: ${nodes}\n  from facts: ${facts}\nFix the difference, or list it in tools/pack-harness/src/knownDifferences.ts with the reason.`,
    );
  }

  private nodeOps(node: Node): CallOps | undefined {
    if (
      !Node.isCallExpression(node) &&
      !Node.isNewExpression(node) &&
      !Node.isTaggedTemplateExpression(node)
    ) {
      return undefined;
    }
    const store = this.store;
    return callOpsFor(node, {
      resolve: (value) => store.resolveWrittenValue(value),
      resolution: store,
      originatesFrom: this.originatesFrom,
      anchorCallsOf: (value, matches) => store.anchorCallsOf(value, matches),
    });
  }
}
