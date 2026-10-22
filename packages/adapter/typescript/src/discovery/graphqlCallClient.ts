/**
 * graphqlCallClient.ts: the client an operation's own call passes, read
 * at that one call.
 *
 * Apollo sends a hook's operation through the client the app provides,
 * unless the call passes a `client` option, and an imperative
 * `client.query` goes through the client it is called on. A project
 * hook that picks the client from an option of its own decides per
 * caller, so the caller's arguments are bound before the choice is
 * read. Each client construction the packs describe is replaced by a
 * token of its own, and the evaluator says which token the choice comes
 * out as. The README beside this file says what becomes of an operation
 * whose choice stays open.
 */

import { Node } from "ts-morph";

import { force, hole, text, type Value } from "@suss/values";

import { ResolutionStore } from "../facts/store.js";
import { evaluatedValueThrough } from "../values/evaluator.js";
import {
  constructionEndpoint,
  type GraphqlClientConstruction,
  type GraphqlClientRef,
  type GraphqlClientSpec,
  graphqlClientConstructions,
} from "./graphqlClientConstruction.js";
import { objectLiteralOf, propertyOf } from "./resolveValue.js";

import type { CallExpression, SourceFile } from "ts-morph";

/** Where one operation's call takes its client. */
export interface GraphqlCallSite {
  /** The library call that sends the operation. */
  call: CallExpression;
  /** The project's own wrapper calls between the unit and `call`, innermost first. */
  through: CallExpression[];
  /** The client is the receiver of `call`, or an option in one of its arguments. */
  client: "receiver" | { argument: number; property: string };
}

export type ClientChosenAtCall =
  | { kind: "settled"; client: GraphqlClientRef }
  | { kind: "unresolved"; reference: string; reason: string };

const REFERENCE_LIMIT = 80;

/**
 * The client the call at `site` passes, or null when it leaves the
 * choice to the client the app provides. A receiver suss cannot follow
 * is left to the app as well, since every imperative call is written
 * on a receiver whether or not it picks a client.
 */
export function clientChosenAt(
  site: GraphqlCallSite,
  specs: ReadonlyArray<GraphqlClientSpec>,
  resolution: ResolutionStore | undefined,
): ClientChosenAtCall | null {
  const store = resolution ?? new ResolutionStore();
  const written = writtenClientOf(site, store);
  if (written === null) {
    return null;
  }

  const constructions = constructionsInProject(
    site.call.getSourceFile(),
    specs,
    store,
  );
  const tokens = new Map<Node, Value>(
    constructions.map((construction, at) => [
      construction.node,
      text(`suss:client#${at}`),
    ]),
  );
  const value = evaluatedValueThrough(
    written.node,
    site.through,
    store,
    tokens,
  );
  const chosen =
    value === null
      ? unreadChain(written, store)
      : clientValueOf(value, written.property);
  if (chosen === undefined) {
    return null;
  }

  const picked = tokensIn(chosen, constructions.length);
  if (picked !== null && picked.length === 1) {
    const construction = constructions[picked[0] as number];
    const endpoint =
      construction === undefined
        ? null
        : constructionEndpoint(construction, constructions, store);
    return {
      kind: "settled",
      client: endpoint ?? { uri: null, uriRef: null },
    };
  }

  if (picked === null && written.property === null) {
    return null;
  }

  const reference = referenceOf(written.node, written.property, store);
  const passes =
    written.property === null
      ? "the client it is called on"
      : "the client it passes";
  if (picked !== null && picked.length > 1) {
    return {
      kind: "unresolved",
      reference,
      reason: `${passes}, ${reference}, can be any of ${picked.length} clients, and nothing the call passes settles which`,
    };
  }
  return {
    kind: "unresolved",
    reference,
    reason: `${passes}, ${reference}, does not come out as one client construction suss can read`,
  };
}

interface WrittenClient {
  /** The receiver, or the argument the option is read off. */
  node: Node;
  /** The option's name, or null for a receiver. */
  property: string | null;
}

function writtenClientOf(
  site: GraphqlCallSite,
  store: ResolutionStore,
): WrittenClient | null {
  if (site.client === "receiver") {
    const callee = site.call.getExpression();
    return Node.isPropertyAccessExpression(callee)
      ? { node: callee.getExpression(), property: null }
      : null;
  }

  const options = site.call.getArguments()[site.client.argument];
  if (options === undefined) {
    return null;
  }
  // Most direct hook calls pass options with no client in them, and those
  // need no evaluating. Through a wrapper, a client can arrive in a
  // spread of the wrapper's parameter, which only the bindings show.
  const direct = site.through.length === 0;
  if (direct && optionWritten(options, site.client.property, store) === null) {
    return null;
  }
  return { node: options, property: site.client.property };
}

/**
 * The value of the client, or undefined when the call leaves the client
 * to the app. An options object suss cannot read says nothing about a
 * client, so it counts as leaving the choice to the app.
 */
function clientValueOf(
  value: Value,
  property: string | null,
): Value | undefined {
  const forced = force(value);
  if (property === null) {
    return isUndefined(forced) ? undefined : forced;
  }

  if (forced.kind !== "record") {
    return undefined;
  }
  const field = forced.fields.get(property);
  if (field === undefined || isUndefined(force(field.value))) {
    return undefined;
  }
  return force(field.value);
}

/** A wrapper call the evaluator could not run leaves open only a client the call writes out. */
function unreadChain(
  written: WrittenClient,
  store: ResolutionStore,
): Value | undefined {
  if (written.property === null) {
    return hole("client");
  }
  return optionWritten(written.node, written.property, store) === null
    ? undefined
    : hole("client");
}

function isUndefined(value: Value): boolean {
  return (
    value.kind === "constant" &&
    value.options.every((option) => option === undefined)
  );
}

/** Which constructions a value can be, or null when it can be anything else too. */
function tokensIn(value: Value, count: number): number[] | null {
  if (value.kind !== "string" || value.pieces.length !== 1) {
    return null;
  }
  const piece = value.pieces[0];
  if (piece?.kind !== "text") {
    return null;
  }
  const picked: number[] = [];
  for (const option of piece.options) {
    const at = /^suss:client#(\d+)$/.exec(option)?.[1];
    if (at === undefined || Number(at) >= count) {
      return null;
    }
    picked.push(Number(at));
  }
  return picked;
}

/** The client as the call writes it, shortened to fit a sentence. */
function referenceOf(
  node: Node,
  property: string | null,
  store: ResolutionStore,
): string {
  const written =
    property === null ? node : optionWritten(node, property, store);
  const shown =
    written === null
      ? `${node.getText()}.${property}`
      : writtenText(written, store);
  return shown.length > REFERENCE_LIMIT
    ? `${shown.slice(0, REFERENCE_LIMIT - 3)}...`
    : shown;
}

function optionWritten(
  options: Node,
  property: string,
  store: ResolutionStore,
): Node | null {
  const literal = objectLiteralOf(options, store);
  return literal === null ? null : propertyOf(literal, property, store);
}

/** A local name shows what it was written as, so the reason shows the choice. */
function writtenText(node: Node, store: ResolutionStore): string {
  if (!Node.isIdentifier(node)) {
    return node.getText();
  }
  const value = store.resolveWrittenValue(node);
  return value === null ? node.getText() : value.getText();
}

const constructionsByStore = new WeakMap<
  ResolutionStore,
  WeakMap<ReadonlyArray<GraphqlClientSpec>, GraphqlClientConstruction[]>
>();

/** Read once per run: every construction in the project's own files. */
function constructionsInProject(
  sourceFile: SourceFile,
  specs: ReadonlyArray<GraphqlClientSpec>,
  store: ResolutionStore,
): GraphqlClientConstruction[] {
  const bySpecs =
    constructionsByStore.get(store) ??
    new WeakMap<
      ReadonlyArray<GraphqlClientSpec>,
      GraphqlClientConstruction[]
    >();
  constructionsByStore.set(store, bySpecs);
  const known = bySpecs.get(specs);
  if (known !== undefined) {
    return known;
  }

  const files = sourceFile
    .getProject()
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile() && !file.isInNodeModules());
  const found = graphqlClientConstructions(files, specs, store);
  bySpecs.set(specs, found);
  return found;
}
