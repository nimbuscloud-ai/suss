/**
 * A tree-sitter parse copied once into plain objects, with the part of
 * web-tree-sitter's node API the Python and Ruby adapters read.
 *
 * Every read of a web-tree-sitter node, such as its type, its parent or
 * one of its children, copies the node into the wasm module's memory,
 * calls into it, and wraps what comes back in a new object. The adapters
 * read each tree many times over, so a run spent a third of its time in
 * those calls. The copy is built with one cursor walk, after which the
 * parser frees its own tree. A node is then one object for as long as its
 * tree is kept, so it can be compared with `===` as well as by `id`.
 *
 * A position's column counts UTF-16 code units from the start of its line.
 */

/** The parts of web-tree-sitter's tree cursor the copy reads. */
export interface TreeSitterCursor {
  readonly nodeTypeId: number;
  readonly currentFieldId: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly nodeIsMissing: boolean;
  gotoFirstChild(): boolean;
  gotoNextSibling(): boolean;
  gotoParent(): boolean;
  delete(): void;
}

/** The parts of a web-tree-sitter language the copy reads. */
export interface TreeSitterLanguage {
  readonly types: ReadonlyArray<string | undefined>;
  readonly fields: ReadonlyArray<string | null | undefined>;
  nodeTypeIsNamed(typeId: number): boolean;
}

/** A web-tree-sitter tree, as far as the copy needs one. */
export interface TreeSitterTree {
  readonly language: TreeSitterLanguage;
  walk(): TreeSitterCursor;
}

export interface Point {
  row: number;
  column: number;
}

const NO_CHILDREN: readonly MirroredNode[] = Object.freeze([]);

let nextId = 1;

export class MirroredNode {
  readonly id = nextId++;
  /** @internal Filled in while the tree is copied. */
  children: readonly MirroredNode[] = NO_CHILDREN;
  private named: readonly MirroredNode[] | undefined;

  constructor(
    readonly tree: MirroredTree,
    readonly parent: MirroredNode | null,
    readonly type: string,
    readonly isNamed: boolean,
    readonly isMissing: boolean,
    /** The field this node is under in its parent, if any. */
    readonly fieldName: string | null,
    readonly startIndex: number,
    readonly endIndex: number,
  ) {}

  get text(): string {
    return this.tree.source.slice(this.startIndex, this.endIndex);
  }

  get startPosition(): Point {
    return this.tree.pointAt(this.startIndex);
  }

  get endPosition(): Point {
    return this.tree.pointAt(this.endIndex);
  }

  /** Whether this node is a syntax error, or has one or a missing node anywhere in it. */
  get hasError(): boolean {
    return (
      this.type === "ERROR" ||
      this.isMissing ||
      this.children.some((child) => child.hasError)
    );
  }

  get childCount(): number {
    return this.children.length;
  }

  get namedChildren(): readonly MirroredNode[] {
    if (this.named === undefined) {
      const named = this.children.filter((child) => child.isNamed);
      // Most lists of children are all named, so they share one array.
      this.named =
        named.length === this.children.length ? this.children : named;
    }
    return this.named;
  }

  get namedChildCount(): number {
    return this.namedChildren.length;
  }

  child(index: number): MirroredNode | null {
    return this.children[index] ?? null;
  }

  namedChild(index: number): MirroredNode | null {
    return this.namedChildren[index] ?? null;
  }

  childForFieldName(name: string): MirroredNode | null {
    return this.children.find((child) => child.fieldName === name) ?? null;
  }

  childrenForFieldName(name: string): MirroredNode[] {
    return this.children.filter((child) => child.fieldName === name);
  }

  /** Every node below this one of one of the types, in source order. */
  descendantsOfType(types: string | readonly string[]): MirroredNode[] {
    const wanted = new Set(typeof types === "string" ? [types] : types);
    const found: MirroredNode[] = [];
    const visit = (node: MirroredNode): void => {
      for (const child of node.children) {
        if (wanted.has(child.type)) {
          found.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  /**
   * The smallest node, named or not, that covers `start` to `end`, the way
   * tree-sitter picks it: the first child reaching past both ends.
   */
  descendantForIndex(start: number, end: number = start): MirroredNode {
    let node: MirroredNode = this;
    let descended = true;
    while (descended) {
      descended = false;
      for (const child of node.children) {
        if (child.endIndex < end || child.endIndex <= start) {
          continue;
        }
        if (start < child.startIndex) {
          break;
        }
        node = child;
        descended = true;
        break;
      }
    }
    return node;
  }
}

export class MirroredTree {
  readonly rootNode: MirroredNode;
  private lineStarts: number[] | undefined;

  constructor(
    readonly source: string,
    parsed: TreeSitterTree,
  ) {
    this.rootNode = copyTree(this, parsed);
  }

  /** The copy keeps nothing of tree-sitter's, so there is nothing to free. */
  delete(): void {}

  /** @internal The row and column of a position in the source. */
  pointAt(index: number): Point {
    const starts = this.startsOfLines();
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((starts[middle] as number) <= index) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { row: low, column: index - (starts[low] as number) };
  }

  private startsOfLines(): number[] {
    if (this.lineStarts === undefined) {
      const starts = [0];
      for (
        let at = this.source.indexOf("\n");
        at !== -1;
        at = this.source.indexOf("\n", at + 1)
      ) {
        starts.push(at + 1);
      }
      this.lineStarts = starts;
    }
    return this.lineStarts;
  }
}

/** Copy a tree-sitter tree and free it, since nothing reads it after the copy. */
export function copyAndFree(
  source: string,
  parsed: TreeSitterTree & { delete(): void },
): MirroredTree {
  try {
    return new MirroredTree(source, parsed);
  } finally {
    parsed.delete();
  }
}

/** Whether each type is named, asked of the language once per type. */
const namedTypes = new WeakMap<TreeSitterLanguage, Map<number, boolean>>();

function isNamedType(language: TreeSitterLanguage, typeId: number): boolean {
  let known = namedTypes.get(language);
  if (known === undefined) {
    known = new Map();
    namedTypes.set(language, known);
  }
  let named = known.get(typeId);
  if (named === undefined) {
    named = language.nodeTypeIsNamed(typeId);
    known.set(typeId, named);
  }
  return named;
}

/** A leaf shares one empty list, so a node gets its own only once it has a child. */
function adopt(parent: MirroredNode, child: MirroredNode): void {
  if (parent.children === NO_CHILDREN) {
    parent.children = [child];
    return;
  }
  (parent.children as MirroredNode[]).push(child);
}

function copyTree(tree: MirroredTree, parsed: TreeSitterTree): MirroredNode {
  const language = parsed.language;
  const cursor = parsed.walk();
  const nodeAt = (parent: MirroredNode | null): MirroredNode => {
    const typeId = cursor.nodeTypeId;
    const start = cursor.startIndex;
    const end = cursor.endIndex;
    // Only the parser inserts a missing node, and it takes up no text.
    const missing = start === end && cursor.nodeIsMissing;
    const node = new MirroredNode(
      tree,
      parent,
      language.types[typeId] ?? "ERROR",
      isNamedType(language, typeId),
      missing,
      language.fields[cursor.currentFieldId] ?? null,
      start,
      end,
    );
    if (parent !== null) {
      adopt(parent, node);
    }
    return node;
  };
  try {
    const root = nodeAt(null);
    let current = root;
    for (;;) {
      if (cursor.gotoFirstChild()) {
        current = nodeAt(current);
        continue;
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          return root;
        }
        current = current.parent as MirroredNode;
      }
      current = nodeAt(current.parent);
    }
  } finally {
    cursor.delete();
  }
}
