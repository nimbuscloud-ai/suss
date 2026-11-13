/**
 * What this adapter hands the fact-based ops in `@suss/recognize/ops`:
 * the store's facts, and the reads only TypeScript can make. Each read
 * is the one `callOpsFor` makes, so the two answer alike wherever the
 * facts say what the nodes do.
 */

import { Node, SyntaxKind } from "ts-morph";

import { factReadOps } from "@suss/recognize/ops";

import {
  scalarValueOf,
  stringValuesOf,
  writtenNodeOf,
} from "../discovery/resolveValue.js";
import { dottedPathOf, nodeId } from "../facts/extract.js";
import { encodedIn } from "../values/encoded.js";
import { typedAsExported, typedAsInheriting } from "../values/receiverType.js";
import { fallbackOf, isDefaultedAt } from "../walk/defaulted.js";
import { peelValue } from "../walk/unwrap.js";
import {
  anchorAccepts,
  globalCalleeName,
  literalFlag,
  literalText,
  noteValueNode,
  streamsReachingName,
  valueFormOf,
  writtenShapeOf,
} from "./callOps.js";
import { functionCalledAt } from "./functionBehind.js";
import {
  effectArgOf,
  isImportedFrom,
  methodDeclaredIn,
  type OriginatesFrom,
} from "./invocationEffects.js";
import { readName } from "./readName.js";
import { keysSuppliedAt } from "./suppliedKeys.js";

import type {
  AstCapableValueOps,
  CallOps,
  FactSource,
  ReadOps,
  ValueOps,
} from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";

/** What a caller can put in place of the store's own reads. */
export interface FactSourceOptions {
  /** What a name was written as, such as a walk's answers asked in one question for every call it visits. */
  readonly resolve?: (value: Node) => Node | null;
  /** The adapter's own members for the call at a node, added to the fact ops for it. */
  readonly extend?: (call: Node, ops: CallOps) => CallOps;
  /**
   * Nodes the caller has in hand that the store may not have stated yet,
   * by key: the read site a walk is at, which is stated only once a chain
   * finds it is off a runtime object.
   */
  readonly held?: Map<string, Node>;
}

/** The read ops for one site a walk visits: a property read, an element read, a binding element or a call. */
export function readOpsAt(
  site: Node,
  store: ResolutionStore,
  originatesFrom?: OriginatesFrom,
): ReadOps {
  return new ReadSites(store, originatesFrom).at(site);
}

/**
 * The read ops for each site one walk visits, over one fact source. A
 * walk visits every property read and call in a unit, and a fact source
 * of its own for each would be most of what the walk allocates.
 */
export class ReadSites {
  private readonly held = new Map<string, Node>();
  private readonly source: FactSource;

  constructor(store: ResolutionStore, originatesFrom?: OriginatesFrom) {
    this.source = factSourceFor(store, originatesFrom, { held: this.held });
  }

  at(site: Node): ReadOps {
    const key = nodeId(site);
    this.held.set(key, site);
    return factReadOps(key, this.source);
  }
}

/** The fact source for one run's store. */
export function factSourceFor(
  store: ResolutionStore,
  originatesFrom?: OriginatesFrom,
  options: FactSourceOptions = {},
): FactSource {
  const access = store.factAccess();
  const held = options.held ?? new Map<string, Node>();
  const nodeOf = (key: string): Node | null =>
    access.nodeOf(key) ?? held.get(key) ?? null;
  // The key of a node read without stating it, found again through `held`.
  const hold = (node: Node): string => {
    const key = nodeId(node);
    if (access.nodeOf(key) === undefined) {
      held.set(key, node);
    }
    return key;
  };
  const resolve =
    options.resolve ??
    ((value: Node): Node | null => store.resolveWrittenValue(value));
  const { extend } = options;
  const keyOf = (node: Node | null): string | null =>
    node === null ? null : nodeId(peelValue(node));
  const at = <T>(key: string, empty: T, read: (node: Node) => T): T => {
    const node = nodeOf(key);
    return node === null ? empty : read(node);
  };

  return {
    db: access.db,
    ...(extend === undefined
      ? {}
      : { extend: (key, ops) => at(key, ops, (node) => extend(node, ops)) }),
    extendValue: (key, ops) =>
      at(key, ops, (node) => noteValueNode(withNode(ops, node), node)),
    read: (key) => at(key, undefined, access.state),
    writtenAs: (key) => at(key, null, (node) => keyOf(resolve(node))),
    anchorCalls: (key, origin) =>
      at(key, [], (node) =>
        store
          .anchorCallsOf(node, (candidate) =>
            anchorAccepts(candidate, origin, originatesFrom, store),
          )
          .map(nodeId),
      ),
    importedFrom: (key, module) =>
      at(key, false, (node) => isImportedFrom(node, module, originatesFrom)),
    importedAs: (key, module) =>
      at(key, [], (node) => store.importedAsOf(node, [module])),
    shapeOf: (key) => at(key, null, shapeOf),
    textOf: (key) => at(key, "", (node) => node.getText()),
    formOf: (key) => at(key, "other", valueFormOf),
    literalOf: (key) => at(key, null, literalOf),
    nameOf: (key, unsettled) =>
      at(key, null, (node) => readName(node, { resolve, unsettled })),
    namesOf: (key, cap) =>
      at(key, null, (node) => stringValuesOf(node, store, cap)),
    argOf: (key) => at(key, null, effectArgOf),
    encodedOf: (key) =>
      at(key, null, (node) => {
        const found = encodedIn(node);
        return found === null
          ? null
          : { codec: found.codec, value: nodeId(peelValue(found.value)) };
      }),
    typeShapeOf: (key) => at(key, null, writtenShapeOf),
    spellsGlobal: (key, path) =>
      at(key, false, (node) => dottedPathOf(node) === path),
    callsGlobal: (call, path) =>
      at(
        call,
        false,
        (node) =>
          Node.isCallExpression(node) &&
          globalCalleeName(node.getExpression()) === path,
      ),
    globalsReaching: (key) =>
      at(key, [], (node) => [
        ...streamsReachingName(node, store),
        ...store.environmentsReaching(node),
      ]),
    handedReaching: (key) =>
      at(key, [], (node) => [...store.handedReaching(node)]),
    evaluatedOf: (key) => at(key, null, (node) => scalarValueOf(node, store)),
    comesTo: (key) =>
      at(key, [], (node) => store.resolveComesTo(node).map(nodeId)),
    givesBack: (key) =>
      at(key, null, (node) => keyOf(store.resolveReturnedCallable(node))),
    importSpecifierOf: (key) =>
      at(key, null, (node) =>
        Node.isIdentifier(node)
          ? specifierBound(
              access.db
                .lookup("binds", 0, key)
                .map((row) => nodeOf(String(row[1]))),
            )
          : null,
      ),
    callsProjectMethod: (call) =>
      at(
        call,
        false,
        (node) =>
          Node.isCallExpression(node) && functionCalledAt(node) !== null,
      ),
    returnedBy: (call) =>
      at(call, null, (node) =>
        Node.isCallExpression(node) ? keyOf(writtenNodeOf(node, store)) : null,
      ),
    declares: (call, module) =>
      at(call, false, (node) => {
        // A member read the ops reached through `member()` is its own callee.
        const callee =
          Node.isCallExpression(node) || Node.isNewExpression(node)
            ? node.getExpression()
            : Node.isPropertyAccessExpression(node)
              ? node
              : null;
        return (
          callee !== null &&
          methodDeclaredIn(
            callee,
            module,
            resolve,
            originatesFrom,
            store.generatedModules,
          )
        );
      }),
    typedAs: (call, origin) =>
      at(call, false, (node) => {
        const object = receiverWritten(node);
        return object !== null && typedAsExported(object, origin, store);
      }),
    typedInherits: (call, spec) =>
      at(call, false, (node) => {
        const object = receiverWritten(node);
        return object !== null && typedAsInheriting(object, spec, store);
      }),
    objectOf: (site) =>
      at(site, null, (node) => {
        const object = objectReadOff(node);
        return object === null ? null : hold(object);
      }),
    readsOff: (key) =>
      at(key, [], (node) =>
        readsUnvisitedOff(node).map((site) => {
          access.state(site);
          return nodeId(site);
        }),
      ),
    defaultedAt: (key) => at(key, false, copesWithMissing),
    fallbackOf: (key) =>
      at(key, null, (node) => {
        const fallback = fallbackOf(node);
        return fallback === null ? null : hold(fallback);
      }),
    keysSupplied: (call, object) =>
      at(call, [], (node) => keysSuppliedAt(node, object, store, hold)),
  };
}

/**
 * The object a read site reads off, as the facts key it: past any cast
 * around it. A destructured read is off the value the pattern takes
 * apart. Null for a site that is not a read, such as a call.
 */
function objectReadOff(site: Node): Node | null {
  if (
    Node.isPropertyAccessExpression(site) ||
    Node.isElementAccessExpression(site)
  ) {
    return peelValue(site.getExpression());
  }
  if (!Node.isBindingElement(site)) {
    return null;
  }
  const declaration = site.getParent().getParent();
  const container = Node.isVariableDeclaration(declaration)
    ? declaration.getInitializer()
    : undefined;
  return container === undefined ? null : peelValue(container);
}

/**
 * The reads off a value that the access walk never visits, since it
 * visits property reads and calls only: the element read `o[k]` the value
 * is the object of, or each element of `const { A, B: b } = o`. A rest
 * element takes the entries left over and a computed key cannot be read
 * back, so neither is one.
 */
function readsUnvisitedOff(value: Node): Node[] {
  const parent = value.getParent();
  if (
    Node.isElementAccessExpression(parent) &&
    parent.getExpression() === value
  ) {
    return [parent];
  }
  if (!Node.isVariableDeclaration(parent)) {
    return [];
  }
  const pattern = parent.getNameNode();
  if (!Node.isObjectBindingPattern(pattern)) {
    return [];
  }
  return pattern.getElements().filter((element) => {
    const property = element.getPropertyNameNode() ?? element.getNameNode();
    return (
      element.getDotDotDotToken() === undefined &&
      (Node.isIdentifier(property) || Node.isStringLiteral(property))
    );
  });
}

/** A binding's own default covers a missing value the way `??` does after a read. */
function copesWithMissing(site: Node): boolean {
  if (Node.isBindingElement(site) && site.getInitializer() !== undefined) {
    return true;
  }
  return isDefaultedAt(site);
}

/**
 * The receiver as the source wrote it: `db` in `db.find()`, and in the
 * member read `db.user` the ops reach `db.user.findMany()` through.
 */
function receiverWritten(node: Node): Node | null {
  const callee = Node.isCallExpression(node) ? node.getExpression() : node;
  return Node.isPropertyAccessExpression(callee)
    ? callee.getExpression()
    : null;
}

/** The key the facts give a call, with the call's own facts stated first. */
export function statedFactKey(call: Node, store: ResolutionStore): string {
  store.factAccess().state(call);
  return nodeId(call);
}

/** The value's ops with the node they were read at, for a reader that still walks the tree. */
function withNode(ops: ValueOps, node: Node): AstCapableValueOps {
  return Object.assign(ops, { ast: () => node });
}

/**
 * The module specifier of the import statement a name is bound to, as
 * written. The `imports` facts key a module by the file it resolved to,
 * so the specifier is read off the statement itself.
 */
function specifierBound(declarations: readonly (Node | null)[]): string | null {
  const specifiers = new Set(
    declarations.flatMap((declaration) => {
      const statement = declaration?.getFirstAncestorByKind(
        SyntaxKind.ImportDeclaration,
      );
      return statement === undefined
        ? []
        : [statement.getModuleSpecifierValue()];
    }),
  );
  const [one] = specifiers;
  return specifiers.size === 1 && one !== undefined ? one : null;
}

function shapeOf(node: Node): "object" | "list" | null {
  if (Node.isObjectLiteralExpression(node)) {
    return "object";
  }
  return Node.isArrayLiteralExpression(node) ? "list" : null;
}

/**
 * A string, or a flag, the source writes out, read as `callOpsFor`
 * reads them. A number comes back as a flag, true unless it is zero,
 * since the ops read a number only as a flag.
 */
function literalOf(node: Node): string | boolean | null {
  return literalText(node) ?? literalFlag(node);
}
