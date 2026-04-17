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

export function consumerExpectedStatuses(t: Transition): number[] {
  const statuses: number[] = [];
  for (const pred of t.conditions) {
    collectStatusLiterals(pred, statuses);
  }
  return statuses;
}

function collectStatusLiterals(pred: Predicate, out: number[]): void {
  if (pred.type === "comparison" && pred.op === "eq") {
    const literal = asStatusLiteral(pred.left, pred.right);
    if (literal != null) {
      out.push(literal);
    }
    return;
  }
  if (pred.type === "compound") {
    for (const op of pred.operands) {
      collectStatusLiterals(op, out);
    }
    return;
  }
  if (pred.type === "negation") {
    collectStatusLiterals(pred.operand, out);
  }
}

function asStatusLiteral(a: ValueRef, b: ValueRef): number | null {
  const pairs: Array<[ValueRef, ValueRef]> = [
    [a, b],
    [b, a],
  ];
  for (const [maybeRef, maybeLit] of pairs) {
    if (
      maybeLit.type === "literal" &&
      typeof maybeLit.value === "number" &&
      refLooksLikeStatus(maybeRef)
    ) {
      return maybeLit.value;
    }
  }
  return null;
}

function refLooksLikeStatus(v: ValueRef): boolean {
  if (v.type === "derived") {
    // Destructured: `const { status } = await call()`; later `status === 404`
    // is parsed as a derived value with a destructured derivation.
    if (v.derivation.type === "destructured") {
      return isStatusName(v.derivation.field);
    }
    if (v.derivation.type === "propertyAccess") {
      return isStatusName(v.derivation.property);
    }
  }
  if (v.type === "input") {
    return isStatusName(v.path[v.path.length - 1]);
  }
  if (v.type === "dependency") {
    return isStatusName(v.accessChain[v.accessChain.length - 1]);
  }
  return false;
}

function isStatusName(name: string | undefined): boolean {
  return name === "status" || name === "statusCode";
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
