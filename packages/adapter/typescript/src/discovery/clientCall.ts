/**
 * clientCall.ts: the calls on a client built from a contract, and the
 * check for which object is a client.
 *
 * A `clientCall` pattern says which export builds the client, as
 * ts-rest's `initClient` does. Each method call on what it built, or on
 * the export itself, is a unit named after the function it is written
 * in, and the adapter reads the call's method and path from the
 * contract. `clientReceiverCheckFor` is the hand check the GraphQL
 * imperative client still asks.
 */

import { Node, type SourceFile, SyntaxKind } from "ts-morph";

import {
  allOf,
  anyOf,
  constructedFrom,
  imported,
  receiverFrom,
  spelled,
} from "@suss/recognize";

import { forEachDescendantOfKinds, skipsNothing } from "../walk/rawDescent.js";
import { resolvedModuleFile } from "./importScan.js";
import { clientUnitName, forEachCallIn, methodNameOf } from "./requestCalls.js";
import { resolveImportedLocalName } from "./resolveImport.js";
import { writtenNodesOf } from "./resolveValue.js";
import { findEnclosingFunction } from "./shared.js";

import type { DiscoveryPattern, ReceiverOrigin } from "@suss/extractor";
import type { CallExpression, NewExpression } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

const BINDING_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.Parameter,
]);

type ClientCallMatch = Extract<
  DiscoveryPattern["match"],
  { type: "clientCall" }
>;

/**
 * The method calls on the pattern's client, each a unit of the function
 * it is written in. A client built from a contract sends nothing when it
 * is called as a function, so a call with no receiver is never one.
 */
export function discoverClientCalls(
  sourceFile: SourceFile,
  match: ClientCallMatch,
  kind: string,
  resolution: ResolutionStore,
): DiscoveredUnit[] {
  const client = clientOriginOf(match);
  const units: DiscoveredUnit[] = [];
  forEachCallIn(
    sourceFile,
    resolution,
    () => true,
    (call, ops) => {
      const takes = ops.method() !== null && receiverFrom(client, ops);
      const func = takes ? findEnclosingFunction(call) : null;
      if (func === null) {
        return;
      }
      const methodName = methodNameOf(call);
      units.push({
        func,
        kind,
        name: clientUnitName(func, methodName),
        callSite: { callExpression: call, methodName },
      });
    },
  );
  return units;
}

/**
 * Where the pattern's client comes from: the export itself, what it
 * builds when called, and a default import under the export's own name.
 * A call that builds the client can bind it to any name.
 */
function clientOriginOf(match: ClientCallMatch): ReceiverOrigin {
  const from = [match.importModule];
  return anyOf(
    imported({ from, named: [match.importName] }),
    allOf(spelled(match.importName), imported({ from, named: ["default"] })),
    constructedFrom({ from, named: [match.importName, "default"] }),
  );
}

/** How a pack spells its client: the module, and the export that is the client or builds one. */
interface ClientSpelling {
  readonly importModule: string;
  readonly importName: string;
}

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
  const visit = (node: Node): boolean => {
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
      return false;
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
    return false;
  };
  // A parameter in a type signature can be typed as the client, so types are walked.
  forEachDescendantOfKinds(sourceFile, BINDING_KINDS, visit, skipsNothing);
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

/** The call that built the client `subject` refers to, wherever it was written, or null when nothing ties the subject to one. */
function clientConstructionCall(
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
  if (resolution === undefined || subjects.length === 0) {
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
 * function itself, `initClient(...)` or `new Deck(...)`. Lenient on the
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
    const callee = call.getExpression();
    if (Node.isIdentifier(callee)) {
      deciding.set(call, callee);
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
