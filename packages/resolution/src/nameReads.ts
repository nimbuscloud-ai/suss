/**
 * Where a name is read, over whatever parse tree an adapter hands in.
 *
 * `valueLeftByWrites` needs to know whether a name's writes run once each
 * in source order, and that answer comes from the tree: every write has to
 * be a statement of the scope's own list, and nothing before the last of
 * them may read the name. The walk is the same in every language, so it
 * lives here and each adapter passes a description of its grammar.
 *
 * A description says four things: which node types spell a name, which
 * of them open a body that runs later, how to enumerate a node's
 * children, and which spellings of a name are reads rather than writes or
 * declarations. Nothing here touches a parser.
 */

/** The parts of a parse-tree node these walks read. */
export interface ReadNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
}

/** What one language says about finding reads of a name in its trees. */
export interface NameReads<N extends ReadNode> {
  /** The node types a name is spelled with. Ruby has two, one of them `@name`. */
  nameTypes: ReadonlySet<string>;
  /**
   * The types that open a body running later than the statements around
   * it, so a function, a class, or a Ruby block. A read in there happens
   * when something calls or enters the body, not where it is written.
   */
  laterBodies: ReadonlySet<string>;
  /** A node's children, in source order. */
  childrenOf: (node: N) => N[];
  /**
   * Whether a node spelling the name reads it, rather than being written
   * to, declared, or spelled as somebody else's member.
   */
  isRead: (node: N) => boolean;
}

/** What one language says about which part of a chained expression is read first. */
export interface ChainReads<N extends ReadNode> {
  /** The node types a name is spelled with. Ruby has two, one of them `@name`. */
  nameTypes: ReadonlySet<string>;
  /**
   * The part of an expression read before the rest of it, so a call's
   * callee or a member read's object, or null when nothing is read before
   * this node.
   */
  readFirst: (node: N) => N | null;
}

/** One write to a name, in the order it is written. */
export interface OrderedWrite<N extends ReadNode> {
  /** The node whose position orders this write among the scope's others. */
  at: N;
  /** Whether the write is a statement of the scope's own statement list. */
  direct: boolean;
}

/**
 * Whether the writes run once each, in the order they are written.
 *
 * They do when every one of them is a statement of the scope's own list.
 * That list runs through once, top to bottom: nothing repeats and nothing
 * is skipped. A write inside a branch, a loop, a block or a nested
 * definition runs when something reaches it, and how many times is not a
 * question this reads.
 *
 * The last write also has to be the one every read sees, so a read before
 * it makes the answer depend on where the reader is, which the rules
 * cannot express.
 */
export function writesRunInOrder<N extends ReadNode>(
  scope: N | null,
  name: string,
  writes: readonly OrderedWrite<N>[],
  rules: NameReads<N>,
): boolean {
  const last = writes[writes.length - 1];
  if (scope === null || last === undefined) {
    return false;
  }
  if (!writes.every((write) => write.direct)) {
    return false;
  }
  return !isReadBefore(scope, name, last.at.startIndex, rules);
}

/** Whether anything in the scope before `position` reads the name. */
function isReadBefore<N extends ReadNode>(
  scope: N,
  name: string,
  position: number,
  rules: NameReads<N>,
): boolean {
  let found = false;
  const visit = (node: N): void => {
    if (found || node.startIndex >= position) {
      return;
    }
    if (rules.laterBodies.has(node.type)) {
      return;
    }
    if (rules.nameTypes.has(node.type) && node.text === name) {
      found = rules.isRead(node);
      return;
    }
    for (const child of rules.childrenOf(node)) {
      visit(child);
    }
  };
  for (const child of rules.childrenOf(scope)) {
    visit(child);
  }
  return found;
}

/**
 * Whether reading this expression starts by reading `name`, through
 * however many calls, member reads and parentheses. That is what makes
 * `query = query.filter(x)` a write narrowing what the other writes gave
 * the name rather than one replacing it.
 */
export function startsAtName<N extends ReadNode>(
  node: N,
  name: string,
  rules: ChainReads<N>,
): boolean {
  if (rules.nameTypes.has(node.type)) {
    return node.text === name;
  }
  const inner = rules.readFirst(node);
  return inner !== null && startsAtName(inner, name, rules);
}
