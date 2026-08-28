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

import { Node, type SourceFile } from "ts-morph";

import { matchingImportDeclarations } from "./importScan.js";
import { resolveImportedLocalName } from "./resolveImport.js";
import { writtenNodeOf } from "./resolveValue.js";
import { type DiscoveredUnit, findEnclosingFunction } from "./shared.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { CallExpression, NewExpression } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

type ClientCallMatch = Extract<
  DiscoveryPattern["match"],
  { type: "clientCall" }
>;

export function discoverClientCalls(
  sourceFile: SourceFile,
  match: ClientCallMatch,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];
  const isGlobal = match.importModule === "global";

  // Step 1: Resolve the local name of the imported identifier, in
  // THIS file. A file that neither imports the client itself nor
  // has a chain resolution could follow back to one has nothing
  // this pattern can match without cross-file help, so it's only
  // skipped outright when there's no resolution store to ask.
  //
  // Strict on the default-import spelling: this is the name THIS
  // file's own bare `axios.get(...)`-style calls are matched
  // against below, and the convention this pack matches same-file is
  // `import axios from "axios"`, documented in the README.
  const importedLocalName = isGlobal
    ? match.importName
    : resolvedImportLocalName(
        sourceFile,
        match.importModule,
        match.importName,
        /* strictDefaultName */ true,
        resolution,
      );

  if (importedLocalName === null && resolution === undefined) {
    return results;
  }

  // Step 2: For non-global imports, find variables set to the result of
  // calling the imported function (`const client = initClient(...)`) OR
  // calling one of its declared factory methods (`const api = axios.create(...)`),
  // built right here in this file.
  const clientVarNames = new Set<string>();

  if (!isGlobal && importedLocalName !== null) {
    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const init = varDecl.getInitializer();
      if (
        init !== undefined &&
        (Node.isCallExpression(init) || Node.isNewExpression(init)) &&
        isInstanceCreationCall(init, importedLocalName, match.factoryMethods)
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
      if (callee.getText() === importedLocalName) {
        matched = true;
      }
    } else if (Node.isPropertyAccessExpression(callee)) {
      // Method call. Three shapes:
      //   1. client.getUser(...)   `client` is a variable set to the
      //      result of calling the import (e.g. `const client =
      //      initClient(...)`), built in THIS file.
      //   2. axios.get("/users")   the import itself is the client and
      //      methods are called on it directly.
      //   3. api.get("/users")     `api` is a name imported from
      //      wherever the instance was built, resolved through the
      //      fact layer rather than read off this file.
      const subject = callee.getExpression();
      if (
        Node.isIdentifier(subject) &&
        ((importedLocalName !== null &&
          subject.getText() === importedLocalName) ||
          clientVarNames.has(subject.getText()) ||
          resolvesToKnownInstance(subject, match, resolution))
      ) {
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

    results.push({
      func: enclosingFunc,
      kind,
      name: clientUnitName(enclosingFunc, methodName),
      callSite: {
        callExpression: node,
        methodName,
      },
    });
  });

  return results;
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
  if (localName !== null) {
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
            isInstanceCreationCall(init, localName, match.factoryMethods)) ||
          typedAsClient(node.getTypeNode(), localName)
        ) {
          constructedHere.add(node.getName());
        }
        return;
      }
      if (
        Node.isParameterDeclaration(node) &&
        typedAsClient(node.getTypeNode(), localName)
      ) {
        const written = node.getNameNode();
        if (Node.isIdentifier(written)) {
          constructedHere.add(written.getText());
        }
      }
    });
  }
  const full: ClientCallMatch = {
    type: "clientCall",
    importModule: match.importModule,
    importName: match.importName,
    ...(match.factoryMethods === undefined
      ? {}
      : { factoryMethods: match.factoryMethods }),
  } as ClientCallMatch;
  return (subject) =>
    (localName !== null &&
      Node.isIdentifier(subject) &&
      subject.getText() === localName) ||
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
  if (resolution === undefined || match.importModule === "global") {
    return false;
  }
  const written = writtenNodeOf(subject, resolution);
  if (
    written === null ||
    (!Node.isCallExpression(written) && !Node.isNewExpression(written))
  ) {
    // Null means not-my-call, and a subject the store never ties to a
    // construction is exactly that.
    return false;
  }

  const writtenLocalName = resolvedImportLocalName(
    written.getSourceFile(),
    match.importModule,
    match.importName,
    /* strictDefaultName */ false,
    resolution,
  );
  return (
    writtenLocalName !== null &&
    isInstanceCreationCall(written, writtenLocalName, match.factoryMethods)
  );
}

/**
 * Whether `call` is the imported function itself (`initClient(...)`)
 * or one of its declared factory methods (`axios.create(...)`),
 * against `importedLocalName`, how the import is bound in `call`'s
 * OWN file, which is not necessarily the file asking the question.
 */
function isInstanceCreationCall(
  call: CallExpression | NewExpression,
  importedLocalName: string,
  factoryMethods: string[] | undefined,
): boolean {
  const calleeText = call.getExpression().getText();
  if (calleeText === importedLocalName) {
    return true;
  }
  return (
    factoryMethods?.some((m) => calleeText === `${importedLocalName}.${m}`) ??
    false
  );
}

/**
 * The local name `importName` (from `importModule`) is bound to in
 * `sourceFile`, or null when that file doesn't import it at all.
 *
 * `strictDefaultName` decides how a default import is read. A named
 * import always matches by the name it was exported under, whatever
 * local alias it's imported under; a default export has none, so the
 * caller says whether the local spelling has to be the conventional
 * one this pack matches its own same-file calls against (true), or
 * whether any default import of the right module counts (false),
 * which is what verifying an already-resolved instance's own creating
 * file needs.
 */
function resolvedImportLocalName(
  sourceFile: SourceFile,
  importModule: string,
  importName: string,
  strictDefaultName: boolean,
  resolution: ResolutionStore | undefined,
): string | null {
  for (const importDecl of matchingImportDeclarations(
    sourceFile,
    importModule,
    resolution,
  )) {
    for (const namedImport of importDecl.getNamedImports()) {
      if (
        namedImport.getName() === importName ||
        namedImport.getAliasNode()?.getText() === importName
      ) {
        return namedImport.getAliasNode()?.getText() ?? namedImport.getName();
      }
    }
    const defaultImport = importDecl.getDefaultImport();
    if (
      defaultImport !== undefined &&
      (!strictDefaultName || defaultImport.getText() === importName)
    ) {
      return defaultImport.getText();
    }
  }
  return null;
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
