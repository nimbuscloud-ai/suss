// shared.ts: types + helpers shared by every discovery handler.
//
// The dispatch and the public discoverUnits orchestrator live in
// ./index.ts; this file has only what the per-handler files need
// in common (the DiscoveredUnit type, the FunctionRoot adapter, and
// the simple "walk-to-enclosing-function" helper that two unrelated
// handlers: clientCall and packageImport: both need).

import { type CallExpression, Node } from "ts-morph";

import type { DeployableUnit, MessageBusSemantics } from "@suss/behavioral-ir";
import type {
  DiscoveryPattern,
  InputMappingPattern,
  TerminalPattern,
} from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

export interface ClientCallSite {
  callExpression: CallExpression;
  /** Method name on the client object (e.g. "getUser"), null for bare calls like fetch() */
  methodName: string | null;
}

export interface DiscoveredUnit {
  /**
   * The function this unit is. Null when a registration announced a
   * boundary and the handler it names comes from outside everything
   * this run reads, in which case `announcedAt` is where the unit is
   * and the summary describes a boundary with nothing behind it.
   */
  func: FunctionRoot | null;
  /**
   * The registration that announced a boundary whose handler was never
   * reached. Set exactly when `func` is null, and the unit's location.
   */
  announcedAt?: Node;
  kind: string;
  name: string;
  /**
   * "label" when the name was coined for the reader rather than
   * naming a binding other code can call, the way a registration
   * verb identifies its handler. Absent means the name is a binding.
   */
  nameKind?: "binding" | "label";
  callSite?: ClientCallSite;
  /** The discovery pattern that produced this unit. Set by discoverUnits. */
  pattern?: DiscoveryPattern;
  /**
   * Terminal patterns for this unit's body, when a discoverUnits
   * callback attached them (`DiscoveredCustomUnit.terminals`). A pack
   * whose units follow more than one output convention declares the
   * common one at pack level and attaches the other per unit.
   * `extractCodeStructure` falls back to the pack-level `terminals`
   * when unset.
   */
  terminals?: TerminalPattern[];
  /**
   * Input mapping for this unit, when a discoverUnits callback attached
   * one (`DiscoveredCustomUnit.inputMapping`). Falls back to the
   * pack-level `inputMapping` when unset.
   */
  inputMapping?: InputMappingPattern;
  /**
   * Populated by `resolverMap`-style discovery (GraphQL code-first).
   * The adapter uses it to build a `graphql-resolver` binding directly,
   * without running this through the REST-shaped bindingExtraction
   * path.
   *
   * `schemaSdl` is the typeDefs string captured from the same
   * ApolloServer config object the resolver map came from, when we can
   * statically resolve it (string literal or gql-tagged template,
   * inline or const-bound). The adapter puts it on one summary
   * standing for that schema, and `schemaDocument` is the label
   * pointing every resolver at it.
   */
  resolverInfo?: {
    /** Null when the source never says which type the resolver attaches to. */
    typeName: string | null;
    fieldName: string;
    schemaSdl?: string;
    /** The file whose server config declares the schema. */
    schemaDocument?: string;
  };
  /**
   * Populated by `graphqlHookCall` discovery (GraphQL consumer side).
   * Has the operation shape the adapter uses to build a
   * `graphql-operation` binding. `operationName` is absent for
   * anonymous operations (`gql\`query { ... }\``, no identifier).
   *
   * `document` is the raw GraphQL document source (the inner text of
   * the gql-tagged template literal, backticks stripped). Kept
   * alongside the parsed shape so downstream tools can re-parse if
   * they need additional detail beyond what we surface here. Absent
   * when the document body wasn't statically readable and the header
   * was recovered from `TypedDocumentNode` type arguments: a
   * cross-module codegen reference to a document produced by a helper.
   *
   * `variables` list the `$name: Type` declarations at the operation
   * header. Each becomes an `Input` on the resulting summary so
   * pairing layers can match against resolver args. Empty when the
   * document body wasn't read.
   *
   * `rootFields` is the list of root-level selection names: the
   * fields the operation actually selects under Query / Mutation /
   * Subscription. Used by the checker's pairing pass. Empty when the
   * document body wasn't read.
   *
   * `unresolved` is set when the argument was recognized as a GraphQL
   * document reference but the header couldn't be fully read. The unit
   * is still emitted (operation type comes from the call shape) and the
   * gap surfaces on the summary as `metadata.graphql.unresolvedDocument`
   * so nothing is silently dropped.
   */
  operationInfo?: {
    operationType: "query" | "mutation" | "subscription";
    operationName?: string;
    document?: string;
    variables: Array<{ name: string; type: string; required: boolean }>;
    rootFields: string[];
    unresolved?: { reference: string; reason: string };
  };
  /**
   * Populated by `packageExports` discovery. Has the package identity
   * the adapter uses to build a `function-call` binding
   * with `package` + `exportPath` fields: i.e. a provider summary
   * for a publicly-exported library function.
   */
  packageExportInfo?: {
    packageName: string;
    exportPath: string[];
  };
  /**
   * Populated by `decoratedRoute` discovery (NestJS-style REST
   * controllers). The adapter uses it to build a `rest` binding
   * with `(method, path)` directly, bypassing the
   * `bindingExtraction` config used by Express / Fastify (which
   * extract from `app.get(...)` registration calls: the wrong
   * shape for decorator-driven controllers).
   */
  routeInfo?: {
    method: string | null;
    path: string | null;
  };
  /**
   * Populated by a pack's `discoverUnits` callback for a message-bus
   * consumer whose channel the code gives (a handler factory whose
   * config includes the expected subject). The adapter uses it to build
   * a `message-bus` binding directly, which pairs with producers
   * sending on the same channel.
   */
  channelInfo?: {
    messageBus: MessageBusSemantics["messageBus"];
    /** Null when the pack knows the wire but not the channel on it. */
    channel: string | null;
  };
  /** The thing that gets deployed and runs this unit, when known. */
  deployableUnit?: DeployableUnit;
  /**
   * Metadata merged onto the assembled summary's `metadata` field.
   * Populated when a pack's `discoverUnits` callback stamps provenance
   * on the units it returns (the discovery-layer sibling of the
   * per-sub-unit `metadata` the `subUnits` hook returns).
   */
  metadata?: Record<string, unknown>;
  /**
   * What a discovery handler could not read about the boundary this
   * unit is on. A route whose path is computed is still a route
   * somebody declared, so the unit goes out with no path claimed and
   * this sentence saying which part went unread. It ends up on the
   * summary as an `unreadOutcome` gap.
   */
  unreadBinding?: string;
}

/**
 * Where a unit is in source: the function it is, or the registration
 * that announced a boundary whose handler was never reached. Null when
 * a caller supplied neither, which nothing downstream can locate.
 */
export function unitNode(unit: DiscoveredUnit): Node | null {
  return unit.func ?? unit.announcedAt ?? null;
}

/**
 * What makes two units the same unit. The enclosing function and the
 * kind start it off, and then everything that lets one function be more
 * than one boundary is added on: the package export a caller consumes,
 * the route it serves, the GraphQL field it resolves, the channel it
 * listens on, and the GraphQL operation it runs. A component that loads
 * a user and searches for mentions runs two hooks in one body, and both
 * documents are boundaries.
 *
 * One identity for two dedup passes over overlapping populations.
 * Discovery dedups the units its patterns matched. The adapter claims
 * over those plus the ones a pack's `discoverUnits` callback returned,
 * which never went through discovery at all. Both passes are asking
 * whether they have seen this unit already, so both ask it the same
 * way.
 *
 * Nothing here mentions the file the question was asked from. A barrel
 * puts a name on a function it does not contain, and the function is
 * the same unit whichever module's surface it was reached through.
 */
export function unitDedupKey(unit: DiscoveredUnit): string {
  const at = unitNode(unit);
  const parts = [
    // Offsets are positions within one file, so the file is part of
    // saying which function this is once the question is asked across
    // a whole run.
    at === null
      ? ""
      : `${at.getSourceFile().getFilePath()}:${at.getStart()}-${at.getEnd()}`,
    unit.kind,
    unit.packageExportInfo === undefined
      ? ""
      : `${unit.packageExportInfo.packageName}::${unit.packageExportInfo.exportPath.join(".")}`,
    unit.routeInfo === undefined
      ? ""
      : `${unit.routeInfo.method} ${unit.routeInfo.path}`,
    unit.resolverInfo === undefined
      ? ""
      : `${unit.resolverInfo.typeName}.${unit.resolverInfo.fieldName}`,
    unit.channelInfo === undefined
      ? ""
      : `${unit.channelInfo.messageBus}:${unit.channelInfo.channel}`,
    // An anonymous operation has no name to key on, so use the unit
    // name, which already includes the document reference discovery
    // fell back to.
    unit.operationInfo === undefined
      ? ""
      : `${unit.operationInfo.operationType}.${unit.operationInfo.operationName ?? unit.name}`,
  ];
  return parts.join("-");
}

/** Whether a node is one of the four function-shaped declarations. */
export function isFunctionRoot(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
  );
}

/**
 * The declaration that is the function, for a name the language lets be
 * written more than once.
 *
 * An overload signature is the same function written again with its
 * body left off, and TypeScript hands back every spelling under one
 * name. Recording facts under each of them leaves two candidates where
 * the language has one function, and the store then picks neither.
 *
 * A function a declaration file declares has no body anywhere, and the
 * declaration is all there is of the function, so it speaks for itself.
 */
export function declarationCarryingTheBody(declaration: Node): Node {
  if (
    !Node.isFunctionDeclaration(declaration) &&
    !Node.isMethodDeclaration(declaration)
  ) {
    return declaration;
  }
  return declaration.getImplementation() ?? declaration;
}

/**
 * The function root this node is, or null when it is not one. A name
 * written more than once resolves to the one declaration with the body
 * on it, so two spellings of one function do not become two units.
 */

/**
 * Whether a value could possibly refer to a function. Most exports are
 * object literals, string constants or schemas, and asking the fact
 * layer about those pulls in their import closure to produce a null
 * that was never in doubt.
 */
export function couldResolveToFunction(value: Node): boolean {
  return (
    Node.isCallExpression(value) ||
    Node.isIdentifier(value) ||
    Node.isPropertyAccessExpression(value) ||
    Node.isExportSpecifier(value) ||
    Node.isImportSpecifier(value) ||
    Node.isImportClause(value) ||
    Node.isBindingElement(value)
  );
}

/**
 * Whether following this name could still arrive at a function.
 *
 * A name the file itself writes as an object literal, a string or a
 * tagged template is that, and every rule that could follow the name
 * ends there. Asking anyway walks the file's import closure to produce
 * a null. One hop is enough to tell: what the declaration is set to.
 */
export function couldStillNameAFunction(value: Node): boolean {
  if (!couldResolveToFunction(value)) {
    return false;
  }
  if (!Node.isIdentifier(value)) {
    return true;
  }
  const declaration = value.getSymbol()?.getDeclarations()?.[0];
  if (declaration === undefined || !Node.isVariableDeclaration(declaration)) {
    return true;
  }
  const written = declaration.getInitializer();
  return (
    written === undefined ||
    isFunctionRoot(written) ||
    couldResolveToFunction(written)
  );
}

/**
 * Whether this name is one the surrounding function was given. A
 * registering function's own parameter is whatever its callers passed,
 * so no chain from here reaches a function, however many rules get
 * added.
 *
 * This is one hop of the fact layer's `flowsToParam`: a name bound to a
 * parameter. A value that reaches a parameter through a wrapper call
 * comes out false here.
 */
export function namesAParameter(value: Node): boolean {
  if (!Node.isIdentifier(value)) {
    return false;
  }
  const declaration = value.getSymbol()?.getDeclarations()?.[0];
  return declaration !== undefined && Node.isParameterDeclaration(declaration);
}

export function toFunctionRoot(node: Node): FunctionRoot | null {
  return isFunctionRoot(node)
    ? (declarationCarryingTheBody(node) as FunctionRoot)
    : null;
}

/** Walk to the nearest enclosing function-shaped node, or null if none. */
export function findEnclosingFunction(node: Node): FunctionRoot | null {
  let current = node.getParent();
  while (current !== undefined) {
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current) ||
      Node.isArrowFunction(current) ||
      Node.isMethodDeclaration(current)
    ) {
      return current as FunctionRoot;
    }
    current = current.getParent();
  }
  return null;
}
