// Deriving what somebody asked for, and nothing else.
//
// A rule set written for a whole program derives every conclusion the
// facts support. A caller asking "what does this one value resolve to"
// reads a handful of those and pays for all of them. Profiles of the
// resolution rules show the gap: a rule is attempted a hundred and fifty
// times to produce fourteen tuples, and the tuples nobody reads outnumber
// the ones somebody does by more than ten to one.
//
// The rewrite here is magic sets. Each derived relation gains a companion
// relation saying which of its rows somebody is waiting on, every rule
// gets that companion as its first literal, and the demand propagates
// down each body the way the join binds variables: a rule that needs
// `comesTo(y, z)` to answer `comesTo(x, z)` says so, and the engine
// derives the inner pair because the outer one was asked for.
//
// The caller says which relations have to come out complete. Every other
// derived relation is filled in only as far as those need it, and a
// relation nothing asks for is not derived at all.
//
// This depends on two properties. The rewritten program is positive, so
// it stays inside the semi-naive resume that makes a store evaluating
// after every wave of facts affordable. And demand is a fact like any
// other, so asking a new question is a fact arriving, not a fresh
// fixpoint.
//
// Demand being a fact is also what lets a caller take it back. A
// database that keeps every question ever asked derives over all of them
// each time a file's facts arrive, so the tenth question costs ten
// questions and the thousandth costs a thousand. `demandDriven` lists
// the relations that stay empty until somebody asks, and
// `clearRelations` empties them again once an answer has been read.

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

const demandRewrites = new WeakSet<Rule[]>();

/**
 * Whether `deriveOnDemand` produced this rule array. The evaluator
 * refuses to tag such rules: tags would follow the rewritten rules
 * rather than the ones the caller wrote.
 */
export const isDemandRewritten = (rules: Rule[]): boolean =>
  demandRewrites.has(rules);

/** One demand relation the rewrite created, and what its rows say. */
export interface Demand {
  /** The relation whose rows are being waited on. */
  relation: string;
  /** Which columns of that relation a demand row fixes. */
  bound: readonly boolean[];
  /**
   * The demand relation's name. Each of its rows lists the bound
   * columns' values, in the relation's column order.
   */
  demand: string;
}

/** A rewritten rule set, and which of its relations demand restricts. */
export interface OnDemandRules {
  /** The rewritten rules, ready to evaluate. */
  rules: Rule[];
  /**
   * The relations derived only where a demand fact reaches them, the
   * demand relations included. Every one of these is empty until
   * somebody asks, and only the complete relations are derived from
   * them, so a caller between questions can clear the lot and keep the
   * answers.
   */
  demandDriven: string[];
  /**
   * The demand relations by what they ask for, so a caller can read
   * what the rules are waiting on and go and get it: a store that
   * loads facts lazily reads the demand on a module's exports and
   * extracts that module.
   */
  demands: Demand[];
}

/**
 * Rewrite `rules` so the relations listed in `complete` still come out
 * whole and everything else is derived only where those relations reach.
 *
 * Demand enters as ordinary facts. Give a complete relation a rule whose
 * first literal is a base relation the caller asserts, as in `answer(x,
 * z) <- asked(x), comesTo(x, z)`, and the rewrite turns each `asked`
 * fact into demand for one value's chain.
 *
 * Relations no complete relation reaches are dropped, so a caller reading
 * a relation it did not list gets nothing. Negation is rejected: a
 * demand-restricted relation is smaller than the one a negated literal
 * was written against, and a smaller relation makes `not p(x)` true where
 * it was false.
 */
export function deriveOnDemand(
  rules: Rule[],
  complete: readonly string[],
): OnDemandRules {
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
    for (const written of rulesByHead.get(adorned.relation) ?? []) {
      const r = boundFirst(written, adorned.adornment);
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

  // A relation asked for only one way keeps its name, so a profile stays
  // readable and a caller can read a complete relation back under the name
  // it wrote. An unadorned variant is the whole relation, so it keeps it too.
  const nameOf = (relation: string, adornment: Adornment): string => {
    if (!anyBound(adornment) || variantsOf.get(relation) === 1) {
      return relation;
    }
    return `${relation}:${adornmentKey(adornment)}`;
  };

  const demandOn = (relation: string, adornment: Adornment): string =>
    `wanted:${nameOf(relation, adornment)}`;

  const rewritten: Rule[] = [];
  const demandDriven = new Set<string>();
  const demands: Demand[] = [];
  const already = new Set<string>();
  const emit = (r: Rule): void => {
    const key = JSON.stringify(r);
    if (!already.has(key)) {
      already.add(key);
      rewritten.push(r);
    }
  };

  for (const adorned of asked.values()) {
    if (anyBound(adorned.adornment)) {
      demandDriven.add(nameOf(adorned.relation, adorned.adornment));
      demandDriven.add(demandOn(adorned.relation, adorned.adornment));
      demands.push({
        relation: adorned.relation,
        bound: adorned.adornment,
        demand: demandOn(adorned.relation, adorned.adornment),
      });
    }
    for (const written of rulesByHead.get(adorned.relation) ?? []) {
      const r = boundFirst(written, adorned.adornment);
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
          const demand = positiveLiteral(
            demandOn(literal.relation, adornment),
            boundTerms(literal.terms, adornment),
          );
          const premises = [...guard, ...body];
          if (!sameLiteral(premises, demand)) {
            emit({ head: demand, body: premises });
          }
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

  demandRewrites.add(rewritten);
  return { rules: rewritten, demandDriven: [...demandDriven], demands };
}

/**
 * Whether the only premise is the conclusion itself. A rule saying that
 * a value is wanted because it is wanted derives nothing.
 */
const sameLiteral = (premises: Literal[], conclusion: Literal): boolean =>
  premises.length === 1 &&
  JSON.stringify(premises[0]) === JSON.stringify(conclusion);

/**
 * The rule with its body in the order demand should travel: at each
 * step, the literal with the most columns already fixed, and written
 * order between equals. The README shows what written order costs when
 * the head binds a column the body's first literal does not mention.
 */
function boundFirst(r: Rule, headAdornment: Adornment): Rule {
  const bound = new Set<string>();
  r.head.terms.forEach((term, column) => {
    if (headAdornment[column] && term.type === "variable") {
      bound.add(term.name);
    }
  });
  const boundColumns = (literal: Literal): number =>
    literal.terms.filter(
      (term) => term.type === "constant" || bound.has(term.name),
    ).length;

  const remaining = [...r.body];
  const body: Literal[] = [];
  while (remaining.length > 0) {
    let pick = 0;
    for (let at = 1; at < remaining.length; at++) {
      if (boundColumns(remaining[at]) > boundColumns(remaining[pick])) {
        pick = at;
      }
    }
    const [literal] = remaining.splice(pick, 1);
    body.push(literal);
    for (const term of literal.terms) {
      if (term.type === "variable") {
        bound.add(term.name);
      }
    }
  }
  return { head: r.head, body };
}

/**
 * How each body literal is bound when the join reaches it, in body order,
 * or null where the literal refers to a relation no rule derives. Base
 * relations need no demand: their facts are all there already.
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
