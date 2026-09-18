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

import { pathFromArgument, pathFromProperty } from "../resolve/routePath.js";
import { resolvedModuleFile } from "./importScan.js";
import { resolveImportedLocalName } from "./resolveImport.js";
import { stringPropertyOf, writtenNodeOf } from "./resolveValue.js";
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
  const isGlobal = match.importModule === "global";

  // Step 1: variables set to the result of calling the imported
  // function (`const client = initClient(...)`) or one of its declared
  // factory methods (`const api = axios.create(...)`), built right
  // here in this file. The creation call's callee goes through the
  // fact layer, so an aliased import and one reached through a
  // project barrel build a client the same way a direct import does.
  const clientVarNames = new Set<string>();

  if (!isGlobal) {
    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const init = varDecl.getInitializer();
      if (
        init !== undefined &&
        (Node.isCallExpression(init) || Node.isNewExpression(init)) &&
        isCreationCall(init, match, resolution)
      ) {
        clientVarNames.add(varDecl.getName());
      }
    }
  }

  // Step 3: Walk all call expressions looking for matching client calls
  const methodFilter =
    match.methodFilter !== undefined ? new Set(match.methodFilter) : null;

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const callee = node.getExpression();
    let methodName: string | null = null;
    let matched = false;

    if (isGlobal && Node.isIdentifier(callee)) {
      // Bare call: fetch(...)
      if (callee.getText() === match.importName) {
        matched = true;
      }
    } else if (isGlobal && Node.isPropertyAccessExpression(callee)) {
      // The same global through its object: globalThis.fetch(...)
      if (
        callee.getName() === match.importName &&
        GLOBAL_OBJECTS.has(callee.getExpression().getText())
      ) {
        matched = true;
      }
    } else if (
      match.callable === true &&
      isClientItself(callee, match, clientVarNames, resolution)
    ) {
      // The client called as a function: axios(config), api(config)
      matched = true;
    } else if (Node.isPropertyAccessExpression(callee)) {
      /**
       * Method call, matched four ways: `client.getUser()` on an
       * instance built here, `axios.get()` on the import itself,
       * `api.get()` on an instance the fact layer finds elsewhere, and
       * `client().get()` on what a project function returns.
       */
      const subject = callee.getExpression();
      if (isClientItself(subject, match, clientVarNames, resolution)) {
        methodName = callee.getName();
        if (methodFilter === null || methodFilter.has(methodName)) {
          matched = true;
        }
      }
    }

    if (!matched) {
      return;
    }

    // Step 4: Walk up to the enclosing function
    const enclosingFunc = findEnclosingFunction(node);
    if (enclosingFunc === null) {
      return;
    }

    for (const under of sitesToReadUnder(node, binding, resolution)) {
      results.push({
        func: enclosingFunc,
        kind,
        name: clientUnitName(enclosingFunc, methodName),
        callSite: {
          callExpression: node,
          methodName,
          ...(under === undefined ? {} : { under }),
        },
      });
    }
  });

  return results;
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
 * Whether this expression is the client: the import under its
 * conventional name, an instance this file built from it, or one the
 * fact layer finds built elsewhere.
 */
function isClientItself(
  subject: Node,
  match: ClientCallMatch,
  clientVarNames: Set<string>,
  resolution: ResolutionStore | undefined,
): boolean {
  return (
    (Node.isIdentifier(subject) &&
      (isClientImport(subject, match, resolution, true) ||
        clientVarNames.has(subject.getText()))) ||
    resolvesToKnownInstance(subject, match, resolution)
  );
}

/**
 * Whether `subject`, unresolved in this file, refers to a client instance
 * this pack built somewhere else. `writtenNodeOf` follows the name
 * back to wherever it was written: an import, an alias, a re-export
 * barrel. What it lands on still has to look like this pattern's own
 * instance-creating call, checked against ITS OWN file, since the file
 * that built the instance may import the client under a different
 * local name than any file calling it does.
 *
 * Lenient on the default-import spelling there: `match.importName`
 * identifies which module's default export builds instances, not the
 * local name the creating file happened to give it, so `import ax
 * from "axios"` counts the same as the conventional spelling. A named
 * import still has to match the name it was exported under.
 *
 * A subject the chain doesn't resolve, or one that resolves to
 * something this pattern doesn't recognize as building an instance,
 * composes nothing, the same convention an unresolved path argument
 * already follows.
 */
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
  match: {
    importModule: string;
    importName: string;
    factoryMethods?: string[];
  },
  resolution: ResolutionStore | undefined,
): (subject: Node) => boolean {
  const localName = resolveImportedLocalName(
    sourceFile,
    match.importModule,
    match.importName,
  );
  const constructedHere = new Set<string>();
  // One walk, at any depth. A client built inside a hook body, one
  // handed in through a parameter, and one that exists only by its
  // type annotation are all this pack's client, and a top-level-only
  // scan missed everything a function wraps.
  sourceFile.forEachDescendant((node) => {
    if (Node.isVariableDeclaration(node)) {
      const init = node.getInitializer();
      if (
        (init !== undefined &&
          (Node.isCallExpression(init) || Node.isNewExpression(init)) &&
          isCreationCall(init, match, resolution)) ||
        (localName !== null && typedAsClient(node.getTypeNode(), localName))
      ) {
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
  const full: ClientCallMatch = {
    type: "clientCall",
    importModule: match.importModule,
    importName: match.importName,
    ...(match.factoryMethods === undefined
      ? {}
      : { factoryMethods: match.factoryMethods }),
  } as ClientCallMatch;
  return (subject) =>
    isClientImport(subject, match, resolution, true) ||
    (Node.isIdentifier(subject) && constructedHere.has(subject.getText())) ||
    resolvesToKnownInstance(subject, full, resolution);
}

/** Whether a type annotation ties this value to the imported class. */
function typedAsClient(typeNode: Node | undefined, localName: string): boolean {
  if (typeNode === undefined || !Node.isTypeReference(typeNode)) {
    return false;
  }
  return typeNode.getTypeName().getText() === localName;
}

function resolvesToKnownInstance(
  subject: Node,
  match: ClientCallMatch,
  resolution: ResolutionStore | undefined,
): boolean {
  return clientConstructionCall(subject, match, resolution) !== null;
}

/**
 * The call that built the client `subject` refers to, wherever it was
 * written, or null when nothing ties the subject to one. A caller that
 * needs the construction itself, to read the config object it was
 * given, asks here rather than following the name again on its own.
 */
export function clientConstructionCall(
  subject: Node,
  match: {
    importModule: string;
    importName: string;
    factoryMethods?: string[];
  },
  resolution: ResolutionStore | undefined,
): CallExpression | NewExpression | null {
  if (resolution === undefined || match.importModule === "global") {
    return null;
  }
  const written = writtenNodeOf(subject, resolution);
  if (
    written === null ||
    (!Node.isCallExpression(written) && !Node.isNewExpression(written))
  ) {
    // Null means not-my-call, and a subject the store never ties to a
    // construction is exactly that.
    return null;
  }

  return isCreationCall(written, match, resolution) ? written : null;
}

/**
 * Whether `call` builds this pack's client: the imported function
 * itself (`initClient(...)`, `new Deck(...)`) or one of its declared
 * factory methods (`axios.create(...)`). Lenient on the default
 * import's spelling, since `call` can be in the file that built the
 * instance rather than the one asking, and that file names the import
 * however it likes.
 */
function isCreationCall(
  call: CallExpression | NewExpression,
  match: {
    importModule: string;
    importName: string;
    factoryMethods?: string[];
  },
  resolution: ResolutionStore | undefined,
): boolean {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) {
    return isClientImport(callee, match, resolution, false);
  }

  if (!Node.isPropertyAccessExpression(callee)) {
    return false;
  }
  const base = callee.getExpression();
  return (
    Node.isIdentifier(base) &&
    (match.factoryMethods?.includes(callee.getName()) ?? false) &&
    isClientImport(base, match, resolution, false)
  );
}

/**
 * Whether this identifier is the pack's client import, followed
 * through aliases and project barrels by the fact layer. The strict
 * flag keeps the documented same-file rule: a bare `axios.get(...)`
 * matches only the conventional spelling, `import axios from
 * "axios"`, while a named import matches under any alias.
 */
function isPathShaped(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

function isClientImport(
  subject: Node,
  match: { importModule: string; importName: string },
  resolution: ResolutionStore | undefined,
  strictDefaultName: boolean,
): boolean {
  if (!Node.isIdentifier(subject)) {
    return false;
  }

  if (resolution === undefined) {
    const local = resolveImportedLocalName(
      subject.getSourceFile(),
      match.importModule,
      match.importName,
      strictDefaultName ? {} : { anyRootSpelling: true },
    );
    return local !== null && subject.getText() === local;
  }

  // A path-shaped module says where in the project, so the key the
  // origin question joins on is the resolved file rather than the
  // spelled specifier.
  const moduleKey = isPathShaped(match.importModule)
    ? (resolvedModuleFile(
        subject.getProject(),
        match.importModule,
        resolution,
      )?.getFilePath() ?? match.importModule)
    : match.importModule;
  const origins = resolution.importOriginsOf(subject, [moduleKey]);
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
