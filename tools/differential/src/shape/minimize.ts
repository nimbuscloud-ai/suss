// minimize.ts: cut a failing shape down to the part that matters.
//
// fast-check shrinks the value it drew, which gets the body small but
// leaves every dimension where the draw put it. A finding is only
// useful if a reader can see which dimension caused it, so this walks
// each dimension back toward the plainest value and keeps the change
// whenever the same finding survives. What comes out is the shortest
// program in the space that still produces that finding.

import { collectObservedProps } from "../jsx/componentProgram.js";
import {
  type ComponentShapeSpec,
  repairComponentShape,
  SIMPLEST_COMPONENT_SHAPE,
} from "./componentShape.js";
import { SIMPLEST_ENV_SHAPE } from "./envShape.js";
import { SIMPLEST_PACKAGE_SHAPE } from "./packageShape.js";
import { SIMPLEST_QUEUE_SHAPE } from "./queueShape.js";
import {
  SIMPLEST_APOLLO_RESOLVER,
  SIMPLEST_NEST_RESOLVER,
} from "./resolverShape.js";
import { type ShapeSpec, SIMPLEST_SHAPE } from "./shapeProgram.js";

import type { ComponentProgram } from "../jsx/componentProgram.js";
import type { HandlerProgram } from "../program.js";
import type { EnvShapeSpec } from "./envShape.js";
import type { PackageShapeSpec } from "./packageShape.js";
import type { QueueShapeSpec } from "./queueShape.js";
import type { ApolloResolverSpec, NestResolverSpec } from "./resolverShape.js";
import type { ShapeFinding, ShapeResult } from "./shapeDifferential.js";

/**
 * What a finding is, for the purpose of deciding whether the smaller
 * program still shows the same thing: the oracle plus the invariant
 * name or the path that disagreed, without the values, which change as
 * the program shrinks.
 */
export function findingSignature(finding: ShapeFinding): string {
  return `${finding.oracle}:${finding.detail.split(":")[0]}`;
}

export const signaturesOf = (result: ShapeResult): Set<string> =>
  new Set([
    ...result.findings.map(findingSignature),
    ...result.harnessFailures.map(() => "harness"),
  ]);

export type Runner<S> = (spec: S) => Promise<ShapeResult>;

async function reduce<S>(
  spec: S,
  target: string,
  candidatesOf: (spec: S) => S[],
  run: Runner<S>,
): Promise<S> {
  let current = spec;
  let improved = true;
  while (improved) {
    improved = false;
    const smaller = candidatesOf(current).filter(
      // A dimension whose simplest value it already has, or a body
      // reduction that changes nothing, comes back unchanged. Running
      // those would keep the loop going forever on a shape that is
      // already as small as it gets.
      (candidate) => JSON.stringify(candidate) !== JSON.stringify(current),
    );
    for (const candidate of smaller) {
      const result = await run(candidate);
      if (signaturesOf(result).has(target)) {
        current = candidate;
        improved = true;
        break;
      }
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const handlerBodyCandidates = (body: HandlerProgram): HandlerProgram[] =>
  body.guards.map((_unused, index) => ({
    ...body,
    guards: body.guards.filter((_guard, other) => other !== index),
  }));

const componentBodyCandidates = (
  body: ComponentProgram,
): ComponentProgram[] => {
  const withoutGuard = body.guards.map((_unused, index) => ({
    ...body,
    guards: body.guards.filter((_guard, other) => other !== index),
  }));
  const plainRoot: ComponentProgram = {
    ...body,
    root: { type: "element", tag: "div", children: [] },
  };
  return [...withoutGuard, plainRoot].map((candidate) => ({
    ...candidate,
    props: collectObservedProps(candidate),
  }));
};

const shapeCandidates = (spec: ShapeSpec): ShapeSpec[] => [
  ...(spec.form === SIMPLEST_SHAPE.form
    ? []
    : [{ ...spec, form: SIMPLEST_SHAPE.form }]),
  ...(spec.binding === SIMPLEST_SHAPE.binding
    ? []
    : [{ ...spec, binding: SIMPLEST_SHAPE.binding }]),
  ...(spec.reach === SIMPLEST_SHAPE.reach
    ? []
    : [{ ...spec, reach: SIMPLEST_SHAPE.reach }]),
  ...(spec.result === SIMPLEST_SHAPE.result
    ? []
    : [{ ...spec, result: SIMPLEST_SHAPE.result }]),
  ...handlerBodyCandidates(spec.body).map((body) => ({ ...spec, body })),
];

const componentCandidates = (spec: ComponentShapeSpec): ComponentShapeSpec[] =>
  [
    ...(spec.form === SIMPLEST_COMPONENT_SHAPE.form
      ? []
      : [{ ...spec, form: SIMPLEST_COMPONENT_SHAPE.form }]),
    ...(spec.binding === SIMPLEST_COMPONENT_SHAPE.binding
      ? []
      : [{ ...spec, binding: SIMPLEST_COMPONENT_SHAPE.binding }]),
    ...(spec.route === SIMPLEST_COMPONENT_SHAPE.route
      ? []
      : [{ ...spec, route: SIMPLEST_COMPONENT_SHAPE.route }]),
    ...componentBodyCandidates(spec.body).map((body) => ({ ...spec, body })),
  ].map(repairComponentShape);

const apolloCandidates = (spec: ApolloResolverSpec): ApolloResolverSpec[] => [
  ...(spec.route === SIMPLEST_APOLLO_RESOLVER.route
    ? []
    : [{ ...spec, route: SIMPLEST_APOLLO_RESOLVER.route }]),
  ...(spec.field === SIMPLEST_APOLLO_RESOLVER.field
    ? []
    : [{ ...spec, field: SIMPLEST_APOLLO_RESOLVER.field }]),
  ...(spec.owner === SIMPLEST_APOLLO_RESOLVER.owner
    ? []
    : [{ ...spec, owner: SIMPLEST_APOLLO_RESOLVER.owner }]),
];

const nestResolverCandidates = (spec: NestResolverSpec): NestResolverSpec[] => [
  ...(spec.announcement === SIMPLEST_NEST_RESOLVER.announcement
    ? []
    : [{ ...spec, announcement: SIMPLEST_NEST_RESOLVER.announcement }]),
  ...(spec.operation === SIMPLEST_NEST_RESOLVER.operation
    ? []
    : [{ ...spec, operation: SIMPLEST_NEST_RESOLVER.operation }]),
  ...(spec.method === SIMPLEST_NEST_RESOLVER.method
    ? []
    : [{ ...spec, method: SIMPLEST_NEST_RESOLVER.method }]),
];

export async function minimizeApolloResolverShape(
  spec: ApolloResolverSpec,
  target: string,
  run: Runner<ApolloResolverSpec>,
): Promise<ApolloResolverSpec> {
  return reduce(spec, target, apolloCandidates, run);
}

export async function minimizeNestResolverShape(
  spec: NestResolverSpec,
  target: string,
  run: Runner<NestResolverSpec>,
): Promise<NestResolverSpec> {
  return reduce(spec, target, nestResolverCandidates, run);
}

const envCandidates = (spec: EnvShapeSpec): EnvShapeSpec[] => [
  ...(spec.site === SIMPLEST_ENV_SHAPE.site
    ? []
    : [{ ...spec, site: SIMPLEST_ENV_SHAPE.site }]),
  ...(spec.form === SIMPLEST_ENV_SHAPE.form
    ? []
    : [{ ...spec, form: SIMPLEST_ENV_SHAPE.form }]),
];

export async function minimizeEnvShape(
  spec: EnvShapeSpec,
  target: string,
  run: Runner<EnvShapeSpec>,
): Promise<EnvShapeSpec> {
  return reduce(spec, target, envCandidates, run);
}

const queueCandidates = (spec: QueueShapeSpec): QueueShapeSpec[] => [
  ...(spec.build === SIMPLEST_QUEUE_SHAPE.build
    ? []
    : [{ ...spec, build: SIMPLEST_QUEUE_SHAPE.build }]),
  ...(spec.config === SIMPLEST_QUEUE_SHAPE.config
    ? []
    : [{ ...spec, config: SIMPLEST_QUEUE_SHAPE.config }]),
];

export async function minimizeQueueShape(
  spec: QueueShapeSpec,
  target: string,
  run: Runner<QueueShapeSpec>,
): Promise<QueueShapeSpec> {
  return reduce(spec, target, queueCandidates, run);
}

const packageCandidates = (spec: PackageShapeSpec): PackageShapeSpec[] => [
  ...(spec.route === SIMPLEST_PACKAGE_SHAPE.route
    ? []
    : [{ ...spec, route: SIMPLEST_PACKAGE_SHAPE.route }]),
  ...(spec.form === SIMPLEST_PACKAGE_SHAPE.form
    ? []
    : [{ ...spec, form: SIMPLEST_PACKAGE_SHAPE.form }]),
];

export async function minimizePackageShape(
  spec: PackageShapeSpec,
  target: string,
  run: Runner<PackageShapeSpec>,
): Promise<PackageShapeSpec> {
  return reduce(spec, target, packageCandidates, run);
}

export async function minimizeShape(
  spec: ShapeSpec,
  target: string,
  run: Runner<ShapeSpec>,
): Promise<ShapeSpec> {
  return reduce(spec, target, shapeCandidates, run);
}

export async function minimizeComponentShape(
  spec: ComponentShapeSpec,
  target: string,
  run: Runner<ComponentShapeSpec>,
): Promise<ComponentShapeSpec> {
  return reduce(spec, target, componentCandidates, run);
}
