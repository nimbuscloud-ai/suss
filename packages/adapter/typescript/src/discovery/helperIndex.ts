/**
 * helperIndex.ts: reading the project's own helpers once, before any
 * file is walked.
 *
 * A pack that declares `projectHelpers` gets every helper the project
 * wrote in front of its library, each read in terms of its own
 * parameters, and gives back the patterns and recognizers it would
 * otherwise have taken as config. Those join the pack for the rest of
 * the run, so the match happens at the call site, where the arguments
 * are literal.
 *
 * Built alongside the mount and wrapper indexes, over the same files.
 * The discovery README has the ordering and the cost.
 */

import { Node, type SourceFile } from "ts-morph";

import { nodeId } from "../facts/extract.js";
import { parameterNames, readHelperSinks } from "./helperReading.js";
import { registrationSubjectsOf, subjectNodeFor } from "./registrationCall.js";
import { functionValueOf } from "./resolveValue.js";

import type {
  DiscoveryPattern,
  InvocationRecognizer,
  PatternPack,
  ProjectHelper,
} from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

export interface ProjectHelperIndex {
  /** Discovery patterns `packName` contributed after reading the project. */
  patternsFor(packName: string): readonly DiscoveryPattern[];
  /**
   * Recognizers the packs contributed. They match calls to functions
   * this project declares, so they run wherever a call can appear
   * rather than only where the pack's own import gate reaches.
   */
  contributedRecognizers(): readonly InvocationRecognizer[];
  /**
   * The helper files that shaped what `file` extracts to, so the
   * per-file cache invalidates `file` when one of them is edited.
   */
  helperFilesFor(file: SourceFile): readonly string[];
}

const NO_HELPERS: ProjectHelperIndex = {
  patternsFor: () => [],
  contributedRecognizers: () => [],
  helperFilesFor: () => [],
};

/** A helper as it is collected, before the pack is told about it. */
interface Reading {
  helper: ProjectHelper;
  /** Where it was declared, so two readings of one function fold together. */
  declarationId: string;
}

export function buildProjectHelperIndex(
  sourceFiles: ReadonlyArray<SourceFile>,
  packs: ReadonlyArray<PatternPack>,
  packsByFile: ReadonlyMap<SourceFile, readonly PatternPack[]>,
  resolution: ResolutionStore,
): ProjectHelperIndex {
  const asking = packs.filter((pack) => pack.projectHelpers !== undefined);
  if (asking.length === 0) {
    return NO_HELPERS;
  }

  const patterns = new Map<string, DiscoveryPattern[]>();
  const recognizers: InvocationRecognizer[] = [];
  const helperNames = new Set<string>();
  const helperFiles = new Set<string>();

  for (const pack of asking) {
    const search = pack.projectHelpers?.find;
    if (search === undefined) {
      continue;
    }
    const readings =
      search.by === "subject"
        ? readSubjectHelpers(pack, packsByFile, resolution)
        : readTextHelpers(sourceFiles, search.contains);
    if (readings.length === 0) {
      continue;
    }

    const declared = pack.projectHelpers?.declare(
      readings.map((reading) => reading.helper),
    );
    if (declared === undefined) {
      continue;
    }
    for (const reading of readings) {
      helperNames.add(reading.helper.name);
      helperFiles.add(reading.helper.file);
    }
    if (declared.discovery !== undefined && declared.discovery.length > 0) {
      patterns.set(pack.name, [
        ...(patterns.get(pack.name) ?? []),
        ...declared.discovery,
      ]);
    }
    recognizers.push(...(declared.invocationRecognizers ?? []));
  }

  if (patterns.size === 0 && recognizers.length === 0) {
    return NO_HELPERS;
  }

  const all = [...helperFiles];
  const written = [...helperNames];
  return {
    patternsFor: (packName) => patterns.get(packName) ?? [],
    contributedRecognizers: () => recognizers,
    helperFilesFor: (file) => (mentionsAnyOf(file, written) ? all : []),
  };
}

/** Whether this file writes any of these words, cheaply. */
function mentionsAnyOf(file: SourceFile, written: readonly string[]): boolean {
  const text = file.getFullText();
  return written.some((word) => text.includes(word));
}

/**
 * Helpers found from the call site: a function the project hands one of
 * this pack's own values to. Starting here rather than at the helper's
 * own file is what reaches a helper whose parameter is typed as a
 * project interface and never mentions the library.
 */
function readSubjectHelpers(
  pack: PatternPack,
  packsByFile: ReadonlyMap<SourceFile, readonly PatternPack[]>,
  resolution: ResolutionStore,
): Reading[] {
  const matches = registrationMatchesOf(pack);
  if (matches.length === 0) {
    return [];
  }

  const found = new Map<string, Reading>();
  for (const [sourceFile, packs] of packsByFile) {
    if (!packs.includes(pack)) {
      continue;
    }
    for (const match of matches) {
      const subjects = registrationSubjectsOf(
        sourceFile,
        match.importModule,
        match.importName,
        resolution,
      );
      if (subjects.size === 0) {
        continue;
      }
      collectHandOffs(sourceFile, subjects, match, resolution, found);
    }
  }
  return [...found.values()];
}

type RegistrationMatch = Extract<
  DiscoveryPattern["match"],
  { type: "registrationCall" }
>;

function registrationMatchesOf(pack: PatternPack): RegistrationMatch[] {
  const seen = new Set<string>();
  const matches: RegistrationMatch[] = [];
  for (const pattern of pack.discovery) {
    if (pattern.match.type !== "registrationCall") {
      continue;
    }
    const key = `${pattern.match.importModule}::${pattern.match.importName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    matches.push(pattern.match);
  }
  return matches;
}

/**
 * Every call in this file that hands a routable to a function the
 * project declares, with the helper behind it read.
 */
function collectHandOffs(
  sourceFile: SourceFile,
  subjects: ReadonlyMap<string, Node>,
  match: RegistrationMatch,
  resolution: ResolutionStore,
  found: Map<string, Reading>,
): void {
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee)) {
      return;
    }
    const handedOver = subjectArgument(node, subjects, match, resolution);
    if (handedOver < 0) {
      return;
    }
    const helper = functionValueOf(callee, resolution);
    if (helper === null || helper.getSourceFile() === sourceFile) {
      // A helper in the file that calls it is already walked with the
      // routable in scope, so route discovery reads it without this.
      return;
    }
    record(found, helper, callee.getText(), handedOver);
  });
}

/**
 * Which argument of a call is this pack's routable, or -1 for none.
 *
 * The scan stops at the first one. Putting every later argument to the
 * store as well costs a query per argument of every call in the file,
 * and what it buys is a helper handed two different apps in one call.
 */
function subjectArgument(
  call: Node,
  subjects: ReadonlyMap<string, Node>,
  match: RegistrationMatch,
  resolution: ResolutionStore,
): number {
  if (!Node.isCallExpression(call)) {
    return -1;
  }
  const args = call.getArguments();
  for (const [position, argument] of args.entries()) {
    // Only a name can be the app. A literal written at the call is one
    // the store would decline anyway, at the cost of asking.
    if (
      !Node.isIdentifier(argument) &&
      !Node.isPropertyAccessExpression(argument)
    ) {
      continue;
    }
    if (subjectNodeFor(argument, subjects, match, resolution) !== undefined) {
      return position;
    }
  }
  return -1;
}

/** Fold one more sighting of a helper into what is already known. */
function record(
  found: Map<string, Reading>,
  helper: FunctionRoot,
  name: string,
  subjectParameter: number,
): void {
  const declarationId = nodeId(helper);
  const already = found.get(declarationId);
  if (already !== undefined) {
    if (!already.helper.subjectParameters.includes(subjectParameter)) {
      already.helper.subjectParameters.push(subjectParameter);
    }
    return;
  }
  found.set(declarationId, {
    declarationId,
    helper: {
      name,
      file: helper.getSourceFile().getFilePath(),
      parameters: parameterNames(helper),
      subjectParameters: [subjectParameter],
      sinks: readHelperSinks(helper),
    },
  });
}

/**
 * Helpers found from the body. A pack reached over HTTP has no import
 * to gate on, so it says which strings its protocol uses instead.
 */
function readTextHelpers(
  sourceFiles: ReadonlyArray<SourceFile>,
  contains: readonly string[],
): Reading[] {
  const readings: Reading[] = [];
  for (const sourceFile of sourceFiles) {
    const text = sourceFile.getFullText();
    if (!contains.some((mark) => text.includes(mark))) {
      continue;
    }
    for (const [name, declaration] of declaredFunctions(sourceFile)) {
      readings.push({
        declarationId: nodeId(declaration),
        helper: {
          name,
          file: sourceFile.getFilePath(),
          parameters: parameterNames(declaration),
          subjectParameters: [],
          sinks: readHelperSinks(declaration),
        },
      });
    }
  }
  return readings;
}

/**
 * The named functions this file declares, written either way round: a
 * `function` statement, or a name bound to a function expression.
 */
function declaredFunctions(
  sourceFile: SourceFile,
): Array<[string, FunctionRoot]> {
  const found: Array<[string, FunctionRoot]> = [];
  for (const declaration of sourceFile.getFunctions()) {
    const name = declaration.getName();
    if (name !== undefined) {
      found.push([name, declaration]);
    }
  }
  for (const variable of sourceFile.getVariableDeclarations()) {
    const initializer = variable.getInitializer();
    if (
      initializer !== undefined &&
      (Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer))
    ) {
      found.push([variable.getName(), initializer]);
    }
  }
  return found;
}
