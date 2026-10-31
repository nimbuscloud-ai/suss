/**
 * Where each of a body's calls is written, in the terms the branch test
 * reads: the paths to the statement the call is in, the line that
 * statement starts on, and the try whose cleanup body it is in.
 *
 * The Python and the Ruby adapter ask here once per body. The statements
 * stand in as the engine's terminals, so one enumeration covers every
 * call in the body. Statements are matched by id.
 */

import { enumerateCallStatements } from "./enumeratePaths.js";
import { sharedGatingConditions } from "./gatingConditions.js";
import { IdMap } from "./nodeIdentity.js";

import type { EffectSite } from "../effectGuards.js";
import type { RawCondition } from "../index.js";
import type { StructuredPathConditionsInput } from "./enumeratePaths.js";
import type { Identified } from "./nodeIdentity.js";
import type { ConditionInfo } from "./structuredStatement.js";

/** What an adapter says about its own language for `statementSites`. */
export interface StatementReading<N extends Identified, Cond> {
  /** The statement a node is written in, which is what the lowering keys a path on. */
  statementOf: (node: N) => N | null;
  /** The body lowered with these statements as its terminals. */
  lower: (
    statements: readonly N[],
  ) => Pick<
    StructuredPathConditionsInput<Cond, N>,
    "statements" | "terminalsByStmt"
  >;
  /** The one-based line a node starts on. */
  firstLine: (node: N) => number;
}

/** The paths to each node's statement, and the site an effect at the node has. */
export interface StatementSites<N, Cond> {
  pathsTo: (node: N) => readonly ConditionInfo<Cond>[][] | undefined;
  /** The site for an effect at the node, with the guards the caller read for it. */
  siteOf: (node: N, preconditions: readonly RawCondition[]) => EffectSite;
  /** The site for an effect at the node, with the guards every path to its statement passes. */
  plainSiteOf: (node: N) => EffectSite;
}

export function statementSites<N extends Identified, Cond>(
  nodes: readonly N[],
  reading: StatementReading<N, Cond>,
): StatementSites<N, Cond> {
  // Two calls in one statement have to be asked about through the same
  // node, or only one of them finds the statement's paths.
  const statements = new IdMap<N, N>();
  const statementOfNode = new IdMap<N, N>();
  for (const node of nodes) {
    const written = reading.statementOf(node);
    if (written === null) {
      continue;
    }
    const statement = statements.get(written) ?? written;
    statements.set(statement, statement);
    statementOfNode.set(node, statement);
  }
  const terminals = [...statements].map(([statement]) => statement);
  const enumerated = enumerateCallStatements(
    reading.lower(terminals),
    terminals,
  );

  const pathsTo = (node: N): readonly ConditionInfo<Cond>[][] | undefined => {
    const statement = statementOfNode.get(node);
    return statement === undefined
      ? undefined
      : enumerated.byTerminal.get(statement);
  };
  const siteOf = (
    node: N,
    preconditions: readonly RawCondition[],
  ): EffectSite => {
    const statement = statementOfNode.get(node);
    return {
      line: reading.firstLine(statement ?? node),
      preconditions,
      cleansUpFrom:
        statement === undefined
          ? undefined
          : enumerated.placement.get(statement)?.cleansUpFrom,
    };
  };
  return {
    pathsTo,
    siteOf,
    plainSiteOf: (node) => siteOf(node, sharedGatingConditions(pathsTo(node))),
  };
}
