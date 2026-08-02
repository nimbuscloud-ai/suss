// Deriving what somebody asked for, and nothing else.
//
// A rule set written for a whole program derives every conclusion the
// facts support. A caller asking "what does this one value resolve to"
// reads a handful of those and pays for all of them. Profiles of the
// resolution rules show the gap: a rule is attempted a hundred and fifty
// times to win fourteen tuples, and the tuples nobody reads outnumber the
// ones somebody does by more than ten to one.
//
// The rewrite here is magic sets. Each derived relation gains a companion
// relation saying which of its rows somebody is waiting on, every rule
// gets that companion as its first literal, and the demand propagates
// down each body the way the join binds variables: a rule that needs
// `comesTo(y, z)` to answer `comesTo(x, z)` says so, and the engine
// derives the inner pair because the outer one was asked for.
//
// The caller names the relations that have to come out complete. Every
// other derived relation is filled in only as far as those need it, and a
// relation nothing asks for is not derived at all.
//
// Two properties this leans on. The rewritten program is positive, so it
// stays inside the semi-naive resume that makes a store evaluating after
// every wave of facts affordable. And demand is a fact like any other, so
// asking a new question is a fact arriving, not a fresh fixpoint.

import type { Literal, Rule, Term } from "./index.js";

/**
 * Which of a literal's columns are already fixed by the time the join
 * reaches it: a constant, or a variable an earlier literal bound.
 */
type Adornment = readonly boolean[];

interface AdornedRelation {
  relation: string;
  adornment: Adornment;
}

const adornmentKey = (adornment: Adornment): string =>
  adornment.map((bound) => (bound ? "b" : "f")).join("");

const anyBound = (adornment: Adornment): boolean => adornment.some(Boolean);

const keyOf = ({ relation, adornment }: AdornedRelation): string =>
  `${relation}/${adornmentKey(adornment)}`;

const boundTerms = (terms: Term[], adornment: Adornment): Term[] =>
  terms.filter((_, column) => adornment[column]);

const positiveLiteral = (relation: string, terms: Term[]): Literal => ({
  relation,
  terms,
  negated: false,
});

/**
 * Rewrite `rules` so the relations named in `complete` still come out
 * whole and everything else is derived only where those relations reach.
 *
 * Demand enters as ordinary facts. Give a complete relation a rule whose
 * first literal is a base relation the caller asserts — `answer(x, z) <-
 * asked(x), comesTo(x, z)` — and the rewrite turns each `asked` fact into
 * demand for one value's chain.
 *
 * Relations no complete relation reaches are dropped, so a caller reading
 * a relation it did not name gets nothing. Negation is rejected: a
 * demand-restricted relation is smaller than the one a negated literal
 * was written against, and a smaller relation makes `not p(x)` true where
 * it was false.
 */
export function deriveOnDemand(
  rules: Rule[],
  complete: readonly string[],
): Rule[] {
  const negated = rules.find((r) => r.body.some((l) => l.negated));
  if (negated !== undefined) {
    throw new Error(
      `cannot derive "${negated.head.relation}" on demand: its rule uses negation, ` +
        "and a relation derived only where somebody asked can make a negated literal match where it did not",
    );
  }

  const rulesByHead = new Map<string, Rule[]>();
  for (const r of rules) {
    const existing = rulesByHead.get(r.head.relation);
    if (existing === undefined) {
      rulesByHead.set(r.head.relation, [r]);
    } else {
      existing.push(r);
    }
  }

  const derives = (relation: string): boolean => rulesByHead.has(relation);

  const asked = new Map<string, AdornedRelation>();
  const pending: AdornedRelation[] = [];
  const want = (adorned: AdornedRelation): void => {
    const key = keyOf(adorned);
    if (!asked.has(key)) {
      asked.set(key, adorned);
      pending.push(adorned);
    }
  };

  for (const relation of complete) {
    const derivedBy = rulesByHead.get(relation);
    if (derivedBy === undefined) {
      throw new Error(
        `no rule derives "${relation}", so it cannot be asked for in full`,
      );
    }
    want({ relation, adornment: derivedBy[0].head.terms.map(() => false) });
  }

  while (pending.length > 0) {
    const adorned = pending.pop() as AdornedRelation;
    for (const r of rulesByHead.get(adorned.relation) ?? []) {
      const adornments = bodyAdornments(r, adorned.adornment, derives);
      r.body.forEach((literal, at) => {
        const adornment = adornments[at];
        if (adornment !== null) {
          want({ relation: literal.relation, adornment });
        }
      });
    }
  }

  const variantsOf = new Map<string, number>();
  for (const { relation } of asked.values()) {
    variantsOf.set(relation, (variantsOf.get(relation) ?? 0) + 1);
  }

  // A relation asked for one way keeps its name, which keeps a profile
  // readable and lets a caller read a complete relation back under the
  // name it wrote. An unadorned variant is the whole relation, so it
  // keeps the name whatever else exists.
  const nameOf = (relation: string, adornment: Adornment): string => {
    if (!anyBound(adornment) || variantsOf.get(relation) === 1) {
      return relation;
    }
    return `${relation}:${adornmentKey(adornment)}`;
  };

  const demandOn = (relation: string, adornment: Adornment): string =>
    `wanted:${nameOf(relation, adornment)}`;

  const rewritten: Rule[] = [];
  const already = new Set<string>();
  const emit = (r: Rule): void => {
    const key = JSON.stringify(r);
    if (!already.has(key)) {
      already.add(key);
      rewritten.push(r);
    }
  };

  for (const adorned of asked.values()) {
    for (const r of rulesByHead.get(adorned.relation) ?? []) {
      const guard = anyBound(adorned.adornment)
        ? [
            positiveLiteral(
              demandOn(adorned.relation, adorned.adornment),
              boundTerms(r.head.terms, adorned.adornment),
            ),
          ]
        : [];
      const adornments = bodyAdornments(r, adorned.adornment, derives);
      const body: Literal[] = [];
      r.body.forEach((literal, at) => {
        const adornment = adornments[at];
        if (adornment !== null && anyBound(adornment)) {
          emit({
            head: {
              relation: demandOn(literal.relation, adornment),
              terms: boundTerms(literal.terms, adornment),
            },
            body: [...guard, ...body],
          });
        }
        body.push(
          adornment === null
            ? literal
            : positiveLiteral(
                nameOf(literal.relation, adornment),
                literal.terms,
              ),
        );
      });
      emit({
        head: {
          relation: nameOf(adorned.relation, adorned.adornment),
          terms: r.head.terms,
        },
        body: [...guard, ...body],
      });
    }
  }

  return rewritten;
}

/**
 * How each body literal is bound when the join reaches it, left to right,
 * or null where the literal names a relation no rule derives. Base
 * relations need no demand: their facts are all there already.
 *
 * Left to right because that is the order the evaluator joins in, so what
 * a rule binds by the time it reaches a literal is what this says.
 */
function bodyAdornments(
  r: Rule,
  headAdornment: Adornment,
  derives: (relation: string) => boolean,
): (Adornment | null)[] {
  const bound = new Set<string>();
  r.head.terms.forEach((term, column) => {
    if (headAdornment[column] && term.type === "variable") {
      bound.add(term.name);
    }
  });
  return r.body.map((literal) => {
    const adornment = derives(literal.relation)
      ? literal.terms.map(
          (term) => term.type === "constant" || bound.has(term.name),
        )
      : null;
    for (const term of literal.terms) {
      if (term.type === "variable") {
        bound.add(term.name);
      }
    }
    return adornment;
  });
}
