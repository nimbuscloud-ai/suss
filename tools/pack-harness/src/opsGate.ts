/**
 * Every recognizer a pack test runs is run a second time over the ops in
 * `@suss/recognize/ops`, which read the facts instead of ts-morph nodes.
 * A difference fails the test unless knownDifferences.ts lists it with a
 * reason. The comparison uses a store of its own, so the second run
 * cannot change what the pack's own test sees. `SUSS_OPS_GATE=report.jsonl`
 * writes every difference to that file instead of failing.
 */

import fs from "node:fs";

import { factOpsFor, ResolutionStore } from "@suss/adapter-typescript";

import { isKnownDifference } from "./knownDifferences.js";

import type { Effect } from "@suss/behavioral-ir";
import type { PatternPack } from "@suss/extractor";
import type { Node } from "ts-morph";

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
  private readonly store: ResolutionStore;

  constructor(
    private readonly pack: PatternPack,
    private readonly originatesFrom: (value: Node, module: string) => boolean,
  ) {
    this.store = ResolutionStore.forPacks([pack]);
  }

  /** Run `recognizer` over the fact ops and compare with what it gave over the node ops. */
  compare(
    recognizer: Recognizer,
    node: Node,
    ctx: object,
    fromNodes: Effect[] | null,
  ): void {
    const ops = factOpsFor(node, this.store, (value, module) =>
      this.originatesFrom(value, module),
    );
    let fromFacts: Effect[] | null;
    try {
      fromFacts = recognizer(node, { ...ctx, ops: ops ?? undefined });
    } catch (error) {
      fromFacts = [{ thrown: String(error) } as unknown as Effect];
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
}
