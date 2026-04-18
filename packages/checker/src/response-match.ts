import type {
  BehavioralSummary,
  BoundaryBinding,
  FindingSide,
  Predicate,
  Transition,
  ValueRef,
} from "@suss/behavioral-ir";

export function extractResponseStatus(t: Transition): number | null {
  if (t.output.type !== "response") {
    return null;
  }
  const sc = t.output.statusCode;
  if (sc?.type === "literal" && typeof sc.value === "number") {
    return sc.value;
  }
  return null;
}

export function hasOpaqueStatus(t: Transition): boolean {
  if (t.output.type !== "response") {
    return false;
  }
  const sc = t.output.statusCode;
  return sc != null && sc.type !== "literal";
}

/**
 * Status property names recognised by `consumerExpectedStatuses` and
 * related helpers. Built once per check via `statusAccessorsFor(summary)`
 * (see declared-contract.ts) so the names track the consumer's pack —
 * `["status"]` for fetch/axios today, but extensible without code changes
 * if a pack declares custom names.
 */
export type StatusAccessors = ReadonlySet<string>;

export function consumerExpectedStatuses(
  t: Transition,
  accessors: StatusAccessors,
): number[] {
  const statuses: number[] = [];
  for (const pred of t.conditions) {
    collectStatusLiterals(pred, accessors, statuses);
  }
  return statuses;
}

function collectStatusLiterals(
  pred: Predicate,
  accessors: StatusAccessors,
  out: number[],
): void {
  if (pred.type === "comparison" && pred.op === "eq") {
    const literal = asStatusLiteral(pred.left, pred.right, accessors);
    if (literal != null) {
      out.push(literal);
    }
    return;
  }
  if (pred.type === "compound") {
    for (const op of pred.operands) {
      collectStatusLiterals(op, accessors, out);
    }
    return;
  }
  if (pred.type === "negation") {
    collectStatusLiterals(pred.operand, accessors, out);
  }
}

function asStatusLiteral(
  a: ValueRef,
  b: ValueRef,
  accessors: StatusAccessors,
): number | null {
  const pairs: Array<[ValueRef, ValueRef]> = [
    [a, b],
    [b, a],
  ];
  for (const [maybeRef, maybeLit] of pairs) {
    if (
      maybeLit.type === "literal" &&
      typeof maybeLit.value === "number" &&
      refLooksLikeStatus(maybeRef, accessors)
    ) {
      return maybeLit.value;
    }
  }
  return null;
}

/**
 * Whether `v` is a `ValueRef` that names a status property — i.e. its
 * outermost accessor is one of the configured names.
 *
 * Exported because provider-coverage filters out status-eq predicates
 * when computing sub-case discriminators; sharing this with the rest of
 * the response-match plumbing keeps the recognition rules in one place.
 */
export function refLooksLikeStatus(
  v: ValueRef,
  accessors: StatusAccessors,
): boolean {
  if (v.type === "derived") {
    // Destructured: `const { status } = await call()`; later `status === 404`
    // is parsed as a derived value with a destructured derivation.
    if (v.derivation.type === "destructured") {
      return accessors.has(v.derivation.field);
    }
    if (v.derivation.type === "propertyAccess") {
      return accessors.has(v.derivation.property);
    }
  }
  if (v.type === "input") {
    const last = v.path[v.path.length - 1];
    return last !== undefined && accessors.has(last);
  }
  if (v.type === "dependency") {
    const last = v.accessChain[v.accessChain.length - 1];
    return last !== undefined && accessors.has(last);
  }
  return false;
}

export function makeSide(
  summary: BehavioralSummary,
  transitionId?: string,
): FindingSide {
  const side: FindingSide = {
    summary: `${summary.location.file}::${summary.identity.name}`,
    location: summary.location,
  };
  if (transitionId) {
    side.transitionId = transitionId;
  }
  return side;
}

export function makeBoundary(
  provider: BehavioralSummary,
  consumer: BehavioralSummary,
): BoundaryBinding {
  return (
    provider.identity.boundaryBinding ??
    consumer.identity.boundaryBinding ?? {
      protocol: "unknown",
      framework: "unknown",
    }
  );
}
