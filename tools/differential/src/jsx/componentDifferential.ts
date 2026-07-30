// componentDifferential.ts — the render-boundary differential runner.
//
// For one generated component: extract a summary once, transpile once,
// execute against a deterministic props battery, and judge every
// observation. Mirrors ../differential.ts for the HTTP boundary.

import reactFramework from "@suss/framework-react";

import { extractComponentSummary } from "../extract.js";
import { hashText, mulberry32 } from "../requests.js";
import {
  executeComponent,
  transpileComponentModule,
} from "./componentExecute.js";
import {
  judgeRenderObservation,
  type RenderMismatch,
} from "./componentJudge.js";
import {
  type ComponentProgram,
  collectComparedPropValues,
  collectObservedProps,
  renderComponentModule,
} from "./componentProgram.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

export interface ComponentHarnessFailure {
  props: Record<string, string>;
  message: string;
}

export interface ComponentDifferentialResult {
  moduleSource: string;
  summary: BehavioralSummary;
  propsRun: number;
  mismatches: RenderMismatch[];
  harnessFailures: ComponentHarnessFailure[];
}

const MAX_EXHAUSTIVE = 96;
const SAMPLE_SIZE = 64;

/**
 * Deterministic props battery. Every declared prop is always present
 * (the generated component is well-typed); per prop the battery tries
 * "" (falsy), "a" (generic truthy), and every literal the program
 * compares that prop against. Exhaustive when small, seeded sample
 * otherwise.
 */
export function propsBattery(
  program: ComponentProgram,
): Record<string, string>[] {
  const observed = new Set(collectObservedProps(program));
  // Unobserved props never affect behavior — pin them to one value so
  // the cross product stays over props that matter.
  const pools = program.props.map((prop) => {
    if (!observed.has(prop)) {
      return ["x"];
    }
    return [...new Set(["", "a", ...collectComparedPropValues(program, prop)])];
  });

  const productSize = pools.reduce((acc, pool) => acc * pool.length, 1);
  const toProps = (assignment: string[]): Record<string, string> => {
    const props: Record<string, string> = {};
    for (let i = 0; i < program.props.length; i++) {
      props[program.props[i]] = assignment[i];
    }
    return props;
  };

  if (productSize <= MAX_EXHAUSTIVE) {
    let assignments: string[][] = [[]];
    for (const pool of pools) {
      assignments = assignments.flatMap((prefix) =>
        pool.map((value) => [...prefix, value]),
      );
    }
    return assignments.map(toProps);
  }

  const random = mulberry32(hashText(JSON.stringify(program)));
  const assignments: string[][] = [
    pools.map((pool) => pool[0]),
    pools.map((pool) => pool[pool.length - 1]),
  ];
  for (let i = 0; i < SAMPLE_SIZE; i++) {
    assignments.push(
      pools.map((pool) => pool[Math.floor(random() * pool.length)]),
    );
  }
  return assignments.map(toProps);
}

/** Extract once, execute the battery, adjudicate every observation. */
export async function runComponentDifferential(
  program: ComponentProgram,
): Promise<ComponentDifferentialResult> {
  const moduleSource = renderComponentModule(program);
  const summary = await extractComponentSummary(moduleSource, reactFramework());
  const transpiled = transpileComponentModule(moduleSource);
  const battery = propsBattery(program);

  const mismatches: RenderMismatch[] = [];
  const harnessFailures: ComponentHarnessFailure[] = [];

  for (const props of battery) {
    const execution = executeComponent(transpiled, props);
    if (execution.type === "error") {
      harnessFailures.push({ props, message: execution.message });
      continue;
    }
    const mismatch = judgeRenderObservation(summary, props, execution.observed);
    if (mismatch !== null) {
      mismatches.push(mismatch);
    }
  }

  return {
    moduleSource,
    summary,
    propsRun: battery.length,
    mismatches,
    harnessFailures,
  };
}
