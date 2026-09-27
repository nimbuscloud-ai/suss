// clientCall.ts, discovering call sites of a specific imported client
// (axios, fetch, ts-rest initClient, ...). Each matched call becomes
// a unit identified by its enclosing function; the consumer summary
// describes what that function does around the call.
//
// The dominant production shape builds one client instance in a
// shared module (`const api = axios.create({...})`) and calls it
// from wherever a request is made, often a different file, sometimes
// a hand-written wrapper method that forwards its own argument
// straight through. Reading only the file at hand sees `api` as a
// bare name and stops there. Resolution asks the same question
// registration discovery asks of a mounted router: what value is
// this name written as, wherever that turns out to live, and does it
// look like this pack's own instance-creating call once it lands.
//
// Nothing here has to know about wrappers specifically. A wrapper
// method's own body is another function containing a call on a
// resolved instance, so it's discovered as a client unit whose path
// argument is a parameter rather than a literal. Turning that into a
// summary per caller is expandWrapperCallers's job, unchanged.

import { Node, type SourceFile, SyntaxKind } from "ts-morph";

import { hasNameHole } from "@suss/behavioral-ir";

import {
  pathFromArgument,
  pathFromProperty,
  statesLocalUrl,
} from "../resolve/routePath.js";
import { resolvedModuleFile } from "./importScan.js";
import { resolveImportedLocalName } from "./resolveImport.js";
import { stringPropertyOf, writtenNodesOf } from "./resolveValue.js";
import { type DiscoveredUnit, findEnclosingFunction } from "./shared.js";

import type { BindingExtraction, DiscoveryPattern } from "@suss/extractor";
import type { CallExpression, NewExpression } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

/** The objects a global is reachable through, in a browser or in Node. */
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);

type ClientCallMatch = Extract<
  DiscoveryPattern["match"],
  { type: "clientCall" }
>;

export function discoverClientCalls(
  sourceFile: SourceFile,
  match: ClientCallMatch,
  kind: string,
  resolution?: ResolutionStore,
  binding?: BindingExtraction,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];
  const calls: CallExpression[] = [];
  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      calls.push(node);
    }
  });

  const matched =
    match.importModule === "global"
      ? globalCallsAmong(calls, match)
      : clientCallsAmong(calls, match, sourceFile, resolution);
  for (const call of calls) {
    const methodName = matched.get(call);
    if (methodName === undefined) {
      continue;
    }
    if (fetchesLocally(call, binding, resolution)) {
      continue;
    }
    const enclosingFunc = findEnclosingFunction(call);
    if (enclosingFunc === null) {
      continue;
    }

    for (const under of sitesToReadUnder(call, binding, resolution)) {
      results.push({
        func: enclosingFunc,
        kind,
        name: clientUnitName(enclosingFunc, methodName),
        callSite: {
          callExpression: call,
          methodName,
          ...(under === undefined ? {} : { under }),
        },
      });
    }
  }

  return results;
}

/**
 * Whether the call's URL is one fetch reads without a request, such as
 * a base64 `data:` URI. No provider serves it, so it is no client call.
 */
function fetchesLocally(
  call: CallExpression,
  binding: BindingExtraction | undefined,
  resolution: ResolutionStore | undefined,
): boolean {
  const p = binding?.path;
  if (p?.type !== "fromArgument" && p?.type !== "fromArgumentProperty") {
    return false;
  }
  const arg = call.getArguments()[p.position];
  if (arg === undefined) {
    return false;
  }
  return statesLocalUrl(
    arg,
    p.type === "fromArgumentProperty" ? p.property : undefined,
    resolution,
  );
}

/**
 * The calls of a global client, `fetch(...)` or `globalThis.fetch(...)`,
 * each with no method name. A global has no import or construction for
 * the store to follow, so the callee's spelling decides.
 */
function globalCallsAmong(
  calls: readonly CallExpression[],
  match: ClientCallMatch,
): Map<CallExpression, string | null> {
  const found = new Map<CallExpression, string | null>();
  for (const call of calls) {
    if (isGlobalCall(call.getExpression(), match)) {
      found.set(call, null);
    }
  }
  return found;
}

function isGlobalCall(callee: Node, match: ClientCallMatch): boolean {
  if (Node.isIdentifier(callee)) {
    return callee.getText() === match.importName;
  }
  return (
    Node.isPropertyAccessExpression(callee) &&
    callee.getName() === match.importName &&
    GLOBAL_OBJECTS.has(callee.getExpression().getText())
  );
}

/**
 * The calls on an imported client, with the method each one calls, or
 * null for the client called as a function: `axios(config)`. A method
 * call matches four ways: `client.getUser()` on an instance built here,
 * `axios.get()` on the import itself, `api.get()` on an instance the
 * fact layer finds elsewhere, and `client().get()` on what a project
 * function returns.
 *
 * The receivers are asked about together, because a question per call
 * would run the rules several times for every call in the file. The
 * method filter comes first, so only a receiver it keeps is asked about.
 */
function clientCallsAmong(
  calls: readonly CallExpression[],
  match: ClientCallMatch,
  sourceFile: SourceFile,
  resolution: ResolutionStore | undefined,
): Map<CallExpression, string | null> {
  const builtHere = clientsBuiltAtTopLevel(sourceFile, match, resolution);
  const found = new Map<CallExpression, string | null>();
  if (match.callable === true) {
    const clients = clientSubjectsAmong(
      calls.map((call) => call.getExpression()),
      match,
      builtHere,
      resolution,
    );
    for (const call of calls) {
      if (clients.has(call.getExpression())) {
        found.set(call, null);
      }
    }
  }

  const methodFilter =
    match.methodFilter !== undefined ? new Set(match.methodFilter) : null;
  const methodCalls = new Map<Node, { call: CallExpression; method: string }>();
  for (const call of calls) {
    const callee = call.getExpression();
    if (
      !found.has(call) &&
      Node.isPropertyAccessExpression(callee) &&
      (methodFilter === null || methodFilter.has(callee.getName()))
    ) {
      methodCalls.set(callee.getExpression(), {
        call,
        method: callee.getName(),
      });
    }
  }
  const receivers = clientSubjectsAmong(
    [...methodCalls.keys()],
    match,
    builtHere,
    resolution,
  );
  for (const [receiver, { call, method }] of methodCalls) {
    if (receivers.has(receiver)) {
      found.set(call, method);
    }
  }
  return found;
}

/**
 * Variables set to the result of calling the imported function (`const
 * client = initClient(...)`) or one of its declared factory methods
 * (`const api = axios.create(...)`), built right here in this file. The
 * creation call's callee goes through the fact layer, so an aliased
 * import and one reached through a project barrel build a client the
 * same way a direct import does.
 */
function clientsBuiltAtTopLevel(
  sourceFile: SourceFile,
  match: ClientCallMatch,
  resolution: ResolutionStore | undefined,
): Set<string> {
  const byName = new Map<CallExpression | NewExpression, string>();
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const init = varDecl.getInitializer();
    if (
      init !== undefined &&
      (Node.isCallExpression(init) || Node.isNewExpression(init))
    ) {
      byName.set(init, varDecl.getName());
    }
  }
  const creating = creationCallsAmong([...byName.keys()], match, resolution);
  return new Set(
    [...byName].filter(([init]) => creating.has(init)).map(([, name]) => name),
  );
}

/**
 * Which construction of the surrounding class to read this call under.
 * One entry of `undefined` is the ordinary case: the call says what it
 * reaches wherever the instance came from. A class that takes a piece
 * of the request in its constructor says something different per
 * construction, so each of those becomes a call of its own.
 */
function sitesToReadUnder(
  call: CallExpression,
  binding: BindingExtraction | undefined,
  resolution: ResolutionStore | undefined,
): Array<string | undefined> {
  const cls = call.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  if (binding === undefined || resolution === undefined || cls === undefined) {
    return [undefined];
  }
  const plain = requestStatedBy(call, binding, resolution, undefined);
  if (plain.settled) {
    return [undefined];
  }

  // Two constructions that state the same request are one call, since
  // nothing about the crossing tells them apart.
  const bySignature = new Map<string, string>();
  for (const site of resolution.constructionSitesOf(cls)) {
    const stated = requestStatedBy(call, binding, resolution, site);
    if (stated.signature === plain.signature) {
      continue;
    }
    if (!bySignature.has(stated.signature)) {
      bySignature.set(stated.signature, site);
    }
  }
  return bySignature.size === 0 ? [undefined] : [...bySignature.values()];
}

/** One reading of what a call says about the boundary it reaches. */
interface StatedRequest {
  /** Both halves as one string, for telling two readings apart. */
  signature: string;
  /** Whether every half the call itself writes came out with nothing left open. */
  settled: boolean;
}

function requestStatedBy(
  call: CallExpression,
  binding: BindingExtraction,
  resolution: ResolutionStore,
  site: string | undefined,
): StatedRequest {
  const path = pathStated(call, binding, resolution, site);
  const method = methodStated(call, binding, resolution, site);
  return {
    signature: `${method.text ?? ""}|${path.text ?? ""}`,
    settled: settled(path) && settled(method),
  };
}

/**
 * One half of the request as one read of it came out. `fromCall` says
 * the pack takes it from the call rather than from the pack's own
 * words, which is what makes an unreadable one worth a second look.
 */
interface StatedHalf {
  text: string | undefined;
  fromCall: boolean;
}

const NOT_FROM_THE_CALL: StatedHalf = { text: undefined, fromCall: false };

/** A half the pack takes from the call has to come out with nothing left open. */
function settled(half: StatedHalf): boolean {
  if (!half.fromCall) {
    return true;
  }
  return half.text !== undefined && !hasNameHole(half.text);
}

function pathStated(
  call: CallExpression,
  binding: BindingExtraction,
  resolution: ResolutionStore,
  site: string | undefined,
): StatedHalf {
  const p = binding.path;
  if (p.type !== "fromArgument" && p.type !== "fromArgumentProperty") {
    return NOT_FROM_THE_CALL;
  }
  const arg = call.getArguments()[p.position];
  if (arg === undefined) {
    return NOT_FROM_THE_CALL;
  }
  return {
    fromCall: true,
    text:
      p.type === "fromArgument"
        ? pathFromArgument(arg, resolution, site)
        : pathFromProperty(arg, p.property, resolution, site),
  };
}

function methodStated(
  call: CallExpression,
  binding: BindingExtraction,
  resolution: ResolutionStore,
  site: string | undefined,
): StatedHalf {
  const m = binding.method;
  if (m.type !== "fromArgumentProperty") {
    return NOT_FROM_THE_CALL;
  }
  const arg = call.getArguments()[m.position];
  const stated =
    arg === undefined
      ? null
      : stringPropertyOf(arg, m.property, resolution, site);
  return { fromCall: true, text: stated ?? m.default };
}

/**
 * Which of these subjects are the client: the import under its
 * conventional name, an instance this file built from it, or one the
 * fact layer finds built elsewhere. The subjects are asked about
 * together, so a file's receivers cost a few store questions rather
 * than several each.
 */
function clientSubjectsAmong(
  subjects: readonly Node[],
  match: ClientCallMatch,
  builtHere: ReadonlySet<string>,
  resolution: ResolutionStore | undefined,
): Set<Node> {
  const imported = clientImportsAmong(
    subjects.filter((subject) => Node.isIdentifier(subject)),
    match,
    resolution,
    true,
  );
  const found = new Set<Node>();
  const elsewhere: Node[] = [];
  for (const subject of subjects) {
    if (
      imported.has(subject) ||
      (Node.isIdentifier(subject) && builtHere.has(subject.getText()))
    ) {
      found.add(subject);
      continue;
    }
    elsewhere.push(subject);
  }
  const builtElsewhere = clientConstructionsOf(elsewhere, match, resolution);
  for (const subject of builtElsewhere.keys()) {
    found.add(subject);
  }
  return found;
}

/** How a pack spells its client: the import, and the factories that build one. */
type ClientSpelling = Pick<
  ClientCallMatch,
  "importModule" | "importName" | "factoryMethods"
>;

/**
 * A check for whether an expression is this pack's client.
 *
 * True for the imported value itself, a variable this file sets to a
 * construction of it (a factory call or `new`), and a value the fact
 * layer resolves to such a construction in another file. Any walk that
 * matches methods on a client asks this instead of growing its own
 * receiver rules, so "which object is the client" has one meaning.
 */
export function clientReceiverCheckFor(
  sourceFile: SourceFile,
  match: ClientSpelling,
  resolution: ResolutionStore | undefined,
): (subject: Node) => boolean {
  const localName = resolveImportedLocalName(
    sourceFile,
    match.importModule,
    match.importName,
  );
  const constructedHere = new Set<string>();
  const initializedBy = new Map<CallExpression | NewExpression, string>();
  // One walk at any depth: a client built inside a hook body, handed in
  // through a parameter, or known only by its type annotation is still
  // this pack's client, and a scan of the top level misses all three.
  sourceFile.forEachDescendant((node) => {
    if (Node.isVariableDeclaration(node)) {
      const init = node.getInitializer();
      if (
        init !== undefined &&
        (Node.isCallExpression(init) || Node.isNewExpression(init))
      ) {
        initializedBy.set(init, node.getName());
      }
      if (localName !== null && typedAsClient(node.getTypeNode(), localName)) {
        constructedHere.add(node.getName());
      }
      return;
    }
    if (
      Node.isParameterDeclaration(node) &&
      localName !== null &&
      typedAsClient(node.getTypeNode(), localName)
    ) {
      const written = node.getNameNode();
      if (Node.isIdentifier(written)) {
        constructedHere.add(written.getText());
      }
    }
  });
  const creating = creationCallsAmong(
    [...initializedBy.keys()],
    match,
    resolution,
  );
  for (const [init, name] of initializedBy) {
    if (creating.has(init)) {
      constructedHere.add(name);
    }
  }
  return (subject) =>
    isClientImport(subject, match, resolution, true) ||
    (Node.isIdentifier(subject) && constructedHere.has(subject.getText())) ||
    clientConstructionCall(subject, match, resolution) !== null;
}

/** Whether a type annotation ties this value to the imported class. */
function typedAsClient(typeNode: Node | undefined, localName: string): boolean {
  if (typeNode === undefined || !Node.isTypeReference(typeNode)) {
    return false;
  }
  return typeNode.getTypeName().getText() === localName;
}

/**
 * The call that built the client `subject` refers to, wherever it was
 * written, or null when nothing ties the subject to one. A caller that
 * needs the construction itself, to read the config object it was
 * given, asks here rather than following the name again on its own.
 */
export function clientConstructionCall(
  subject: Node,
  match: ClientSpelling,
  resolution: ResolutionStore | undefined,
): CallExpression | NewExpression | null {
  return (
    clientConstructionsOf([subject], match, resolution).get(subject) ?? null
  );
}

/**
 * The constructions behind the subjects that refer to a client this
 * pack built, possibly in another file. `writtenNodesOf` follows each
 * name back to wherever it was written: an import, an alias, a
 * re-export barrel. What it lands on still has to look like this
 * pattern's own instance-creating call, checked against its own file,
 * since the file that built the instance may import the client under a
 * different local name than any file calling it does.
 *
 * A subject the chain doesn't resolve, or one that resolves to
 * something this pattern doesn't recognize as building an instance, is
 * left out, the same convention an unresolved path argument follows.
 */
function clientConstructionsOf(
  subjects: readonly Node[],
  match: ClientSpelling,
  resolution: ResolutionStore | undefined,
): Map<Node, CallExpression | NewExpression> {
  const found = new Map<Node, CallExpression | NewExpression>();
  if (
    resolution === undefined ||
    match.importModule === "global" ||
    subjects.length === 0
  ) {
    return found;
  }
  const built = new Map<Node, CallExpression | NewExpression>();
  for (const [subject, written] of writtenNodesOf(subjects, resolution)) {
    if (
      written !== null &&
      (Node.isCallExpression(written) || Node.isNewExpression(written))
    ) {
      built.set(subject, written);
    }
  }
  const creating = creationCallsAmong(
    [...new Set(built.values())],
    match,
    resolution,
  );
  for (const [subject, construction] of built) {
    if (creating.has(construction)) {
      found.set(subject, construction);
    }
  }
  return found;
}

/**
 * The calls among these that build this pack's client: the imported
 * function itself (`initClient(...)`, `new Deck(...)`) or one of its
 * declared factory methods (`axios.create(...)`). Lenient on the
 * default import's spelling, since a call can be in the file that
 * built the instance rather than the one asking, and that file can
 * call the import whatever it likes.
 */
function creationCallsAmong(
  calls: readonly (CallExpression | NewExpression)[],
  match: ClientSpelling,
  resolution: ResolutionStore | undefined,
): Set<CallExpression | NewExpression> {
  const deciding = new Map<CallExpression | NewExpression, Node>();
  for (const call of calls) {
    const imported = creationImportOf(call, match);
    if (imported !== null) {
      deciding.set(call, imported);
    }
  }
  const imports = clientImportsAmong(
    [...new Set(deciding.values())],
    match,
    resolution,
    false,
  );
  return new Set(
    [...deciding]
      .filter(([, imported]) => imports.has(imported))
      .map(([call]) => call),
  );
}

/**
 * The identifier whose import decides whether a call builds the client:
 * the callee itself, or the object a declared factory method is called
 * on. Null for a call written any other way.
 */
function creationImportOf(
  call: CallExpression | NewExpression,
  match: ClientSpelling,
): Node | null {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) {
    return callee;
  }
  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const base = callee.getExpression();
  return Node.isIdentifier(base) &&
    (match.factoryMethods?.includes(callee.getName()) ?? false)
    ? base
    : null;
}

function isPathShaped(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

function isClientImport(
  subject: Node,
  match: ClientSpelling,
  resolution: ResolutionStore | undefined,
  strictDefaultName: boolean,
): boolean {
  return (
    Node.isIdentifier(subject) &&
    clientImportsAmong([subject], match, resolution, strictDefaultName).has(
      subject,
    )
  );
}

/**
 * The identifiers among these that are the pack's client import,
 * followed through aliases and project barrels by the fact layer. The
 * strict flag keeps the documented same-file rule: a bare
 * `axios.get(...)` matches only the conventional spelling, `import
 * axios from "axios"`, while a named import matches under any alias.
 */
function clientImportsAmong(
  identifiers: readonly Node[],
  match: ClientSpelling,
  resolution: ResolutionStore | undefined,
  strictDefaultName: boolean,
): Set<Node> {
  const first = identifiers[0];
  if (first === undefined) {
    return new Set();
  }
  if (resolution === undefined) {
    return new Set(
      identifiers.filter((subject) => {
        const local = resolveImportedLocalName(
          subject.getSourceFile(),
          match.importModule,
          match.importName,
          strictDefaultName ? {} : { anyRootSpelling: true },
        );
        return local !== null && subject.getText() === local;
      }),
    );
  }

  // A path-shaped module says where in the project, so the key the
  // origin question joins on is the resolved file rather than the
  // spelled specifier.
  const moduleKey = isPathShaped(match.importModule)
    ? (resolvedModuleFile(
        first.getProject(),
        match.importModule,
        resolution,
      )?.getFilePath() ?? match.importModule)
    : match.importModule;
  const origins = resolution.importOriginsOfMany(identifiers, [moduleKey]);
  return new Set(
    identifiers.filter((subject) =>
      importedAsClient(
        subject,
        origins.get(subject) ?? [],
        match,
        strictDefaultName,
      ),
    ),
  );
}

function importedAsClient(
  subject: Node,
  origins: ReadonlyArray<{ module: string; path: string[] }>,
  match: ClientSpelling,
  strictDefaultName: boolean,
): boolean {
  if (
    origins.some(
      (one) => one.path.length === 1 && one.path[0] === match.importName,
    )
  ) {
    return true;
  }
  const viaDefault = origins.some(
    (one) => one.path.length === 1 && one.path[0] === "default",
  );
  return (
    viaDefault && (!strictDefaultName || subject.getText() === match.importName)
  );
}

/**
 * Pick a stable name for a clientCall-discovered unit by walking the
 * enclosing function's shape. Prefers the function's own identifier,
 * then the variable or property it's bound to, then finally the
 * method name of the call site. "anonymous" is the last-resort
 * label when no other identifier is available.
 */
function clientUnitName(
  enclosingFunc: FunctionRoot,
  methodName: string | null,
): string {
  if (Node.isFunctionDeclaration(enclosingFunc)) {
    return enclosingFunc.getName() ?? methodName ?? "anonymous";
  }
  if (Node.isMethodDeclaration(enclosingFunc)) {
    return enclosingFunc.getName();
  }
  const parent = enclosingFunc.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  if (parent !== undefined && Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  return methodName ?? "anonymous";
}
