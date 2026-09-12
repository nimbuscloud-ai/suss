#!/usr/bin/env node
/**
 * checkReaders.mjs: a value has one reader, and it is not the syntax.
 *
 * What a name was written as, what a template folds to, which function
 * a declaration is, which module an import came from: the evaluator and
 * the resolution store answer all four. An audit found about sixty
 * readers written beside a call site instead, two thirds of them after
 * the facility existed. This scans for the tells of one more.
 *
 * EXEMPT lists the files that already fail. Entries come out as the
 * copies are deleted, and one goes in only with a reason on the line.
 * The rule is in docs/internal/style.md#reading-a-value.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Where a value gets read: the adapters outside the facility, and every pack. */
const SCOPES = [
  "packages/adapter/typescript/src",
  "packages/adapter/python/src",
  "packages/adapter/ruby/src",
  "packages/framework",
  "packages/contract",
  "packages/runtime",
  "packages/client",
];

/**
 * The facility itself. These modules read syntax because reading it is
 * the job they do for everybody else.
 */
const FACILITY = [
  "packages/adapter/typescript/src/values",
  "packages/adapter/typescript/src/facts",
  "packages/adapter/typescript/src/walk",
  "packages/adapter/typescript/src/moduleExports.ts",
  "packages/adapter/typescript/src/resolve/functionBehind.ts",
  "packages/adapter/typescript/src/discovery/resolveValue.ts",
  "packages/adapter/typescript/src/discovery/importScan.ts",
  "packages/adapter/python/src/values",
  "packages/adapter/python/src/facts",
  "packages/adapter/python/src/ast.ts",
  "packages/adapter/ruby/src/values",
  "packages/adapter/ruby/src/facts",
  "packages/adapter/ruby/src/ast.ts",
];

/** A file under a tree-sitter adapter reads a different syntax from a ts-morph one. */
const TREE_SITTER_SCOPES = [
  "packages/adapter/python/src",
  "packages/adapter/ruby/src",
];

/**
 * The textual tells of a second reader. `reads` is "ts-morph" for a
 * probe that only makes sense against the TypeScript adapter's syntax,
 * "tree-sitter" for one that only makes sense against Python's or
 * Ruby's, and "any" for a spelling that turns up in both.
 */
const PROBES = [
  {
    text: ".getInitializer()",
    reads: "ts-morph",
    says: "chases a declaration's initializer; `writtenNodeOf` gives what a name was written as",
  },
  {
    text: ".getSymbol()",
    reads: "ts-morph",
    says: "walks to a symbol to find out what a name is; `resolveWrittenValue` answers that",
  },
  {
    text: ".getDeclarations()",
    reads: "ts-morph",
    says: "walks to a declaration to find out what a name is; `resolveWrittenValue` answers that",
  },
  {
    text: ".getDefinitionNodes()",
    reads: "ts-morph",
    says: "follows an identifier to its definition; `functionTargetOf` and `resolveDecl` do that",
  },
  {
    text: ".getAliasedSymbol()",
    reads: "ts-morph",
    says: "unwraps an import alias by hand; `importOriginsOf` says which module a name came from",
  },
  {
    text: ".getValueDeclaration()",
    reads: "ts-morph",
    says: "takes the declaration behind a symbol; `resolveDecl` does that and follows re-exports",
  },
  {
    text: ".getElements()",
    reads: "ts-morph",
    says: "reads an array literal off the syntax; `arrayLiteralOf` reads one through a name too",
  },
  {
    text: ".getProperties()",
    reads: "ts-morph",
    says: "reads an object's properties off the syntax; `propertiesOf` also folds a spread",
  },
  {
    text: ".getLiteralValue()",
    reads: "ts-morph",
    says: "takes a literal off the syntax; `stringValueOf` also folds a template and a concatenation",
  },
  {
    text: ".getNamedImports()",
    reads: "ts-morph",
    says: "reads an import clause; `namedImportsOf` and `importedNamesOf` do that",
  },
  {
    text: ".getImportDeclarations()",
    reads: "ts-morph",
    says: "scans a file's imports; `matchingImportDeclarations` and `importedRootsOf` do that",
  },
  {
    text: "findReferencesAsNodes",
    reads: "ts-morph",
    says: "searches the project for references; the resolution store already has those edges",
  },
  {
    pattern: /while\s*\([^)]*Node\.is(As|Parenthesized)Expression/,
    label: "while (Node.isAsExpression(...))",
    reads: "ts-morph",
    says: "peels casts or parentheses in a loop; `peelValue` in walk/unwrap.ts does that",
  },
  {
    text: ".text.slice(1, -1)",
    reads: "tree-sitter",
    says: "strips a string node's quotes by index; `stringValueOf` reads the string",
  },
  {
    text: "parseInt(node.text",
    reads: "tree-sitter",
    says: "parses a number off a node's text; `evaluatedValue` gives what the node evaluates to",
  },
  {
    text: "replace(/^[\"']|[\"']$/",
    reads: "any",
    says: "strips the quotes off a node's text; the evaluator hands back the string itself",
  },
  {
    text: "replace(/^:/",
    reads: "any",
    says: "strips a leading symbol colon off a node's text; `symbolValue` in ast.ts does that",
  },
];

/**
 * Files that read syntax today, with the functions that do it. Every
 * entry is either a copy waiting to be deleted or a read that is not
 * about a value at all, and the reason says which.
 */
const EXEMPT = new Map([
  // Reads that are not about a value: type identity, and the shape a
  // type has rather than the value an expression holds.
  [
    "packages/adapter/typescript/src/shapes/typeShapes.ts",
    "reads shapes off the type checker rather than values off expressions",
  ],
  [
    "packages/adapter/typescript/src/promiseThen.ts",
    "receiverIsPromiseTyped asks whether a type is Promise, which is type identity",
  ],
  [
    "packages/framework/prisma/src/index.ts",
    "extendsPrismaClient asks whether a type descends from PrismaClient, which is type identity",
  ],
  [
    "packages/runtime/node/src/processSurface.ts",
    "recognizeElementAccess reads the numeric index of a process.argv access, not a value",
  ],

  // Copies of the facility, waiting on the branches that delete them.
  [
    "packages/adapter/typescript/src/adapter.ts",
    "bindingPatternNames, componentPropsParameters, bindingRole, extractParameters, extractDependencyCalls, fileImporting, internalImportsOf, synthesizeCallerSummaries",
  ],
  [
    "packages/adapter/typescript/src/bootstrap/preFilter.ts",
    "computePackApplicability",
  ],
  [
    "packages/adapter/typescript/src/configuredCall.ts",
    "importsModule, receiverTypeName",
  ],
  [
    "packages/adapter/typescript/src/contract.ts",
    "resolveContractObject, extractEndpointContract, readContract, readContractForClientCall",
  ],
  [
    "packages/adapter/typescript/src/discovery/clientCall.ts",
    "discoverClientCalls, clientReceiverCheckFor, resolvedImportLocalName",
  ],
  [
    "packages/adapter/typescript/src/discovery/decoratedMembers.ts",
    "importedDecoratorLocals, callableOf",
  ],
  [
    "packages/adapter/typescript/src/discovery/decoratedMethod.ts",
    "resolveResolverClassTypeName",
  ],
  [
    "packages/adapter/typescript/src/discovery/decoratorComposition.ts",
    "statesAValue",
  ],
  [
    "packages/adapter/typescript/src/discovery/factorySurface.ts",
    "sameFileFunctionBehind, functionAmong, collectFromObjectLiteral, collectShorthandFunction",
  ],
  [
    "packages/adapter/typescript/src/discovery/graphqlClientConstruction.ts",
    "constructionRegistryStatus, propertyValueOf, resolveToConstructionOf, constructionRef",
  ],
  [
    "packages/adapter/typescript/src/discovery/graphqlImperativeCall.ts",
    "imperativeConfigValue",
  ],
  [
    "packages/adapter/typescript/src/discovery/graphqlShared.ts",
    "writtenStringText, isDocumentTag, documentTagOrigin, declarationFileOf, importCarrying, singleLine, importedVariableInitializers, resolveGqlTemplateText, resolveTypedDocumentHeader, evaluateObjectLiteralAsJson",
  ],
  [
    "packages/adapter/typescript/src/discovery/graphqlWrapper.ts",
    "parameterBehind",
  ],
  [
    "packages/adapter/typescript/src/discovery/helperIndex.ts",
    "declaredFunctions",
  ],
  [
    "packages/adapter/typescript/src/discovery/helperReading.ts",
    "readValue, objectValue, propertyKey",
  ],
  [
    "packages/adapter/typescript/src/discovery/importedCalls.ts",
    "declaredLocally",
  ],
  [
    "packages/adapter/typescript/src/discovery/jsxElementRoute.ts",
    "attributeValueOf, literalStringOf, unitsOfArrayElements",
  ],
  [
    "packages/adapter/typescript/src/discovery/namedExport.ts",
    "discoverNamedExports, defaultExportUnits",
  ],
  [
    "packages/adapter/typescript/src/discovery/packageExports.ts",
    "discoverPackageExports",
  ],
  [
    "packages/adapter/typescript/src/discovery/packageImport.ts",
    "couldBePackageLinked, methodComesFromSource",
  ],
  [
    "packages/adapter/typescript/src/discovery/registrationCall.ts",
    "discoverRegistrationCalls, routeChainOf, collectMethodsCalledOnCallResults, registrationSubjectsOf, discoverMountEdges, extractRouteInfoFromBinding",
  ],
  [
    "packages/adapter/typescript/src/discovery/registrationLoop.ts",
    "tryExpandLoop, loopVariableName, readRouteSpec",
  ],
  [
    "packages/adapter/typescript/src/discovery/registrationTemplate.ts",
    "declaredInModule, readPropertyAsFunction",
  ],
  ["packages/adapter/typescript/src/discovery/resolverMap.ts", "writtenSdl"],
  [
    "packages/adapter/typescript/src/discovery/shared.ts",
    "couldStillNameAFunction, namesAParameter",
  ],
  [
    "packages/adapter/typescript/src/discovery/wrapperFactory.ts",
    "factoryStopOf",
  ],
  [
    "packages/adapter/typescript/src/discoveryContext.ts",
    "valueToAskAbout, resolveDeclarationToFunction",
  ],
  [
    "packages/adapter/typescript/src/parameterReads.ts",
    "pathAbove, parameterReads",
  ],
  ["packages/adapter/typescript/src/paths/lowering.ts", "ownExpressionsOf"],
  [
    "packages/adapter/typescript/src/predicates.ts",
    "parseConditionExpression, tryExpandArrayIncludes",
  ],
  [
    "packages/adapter/typescript/src/resolve/astResolve.ts",
    "resolveElementAccess, shapeFromDeclaration, extractParamNames, safeGetDefinitions, functionBodyOf",
  ],
  [
    "packages/adapter/typescript/src/resolve/callOps.ts",
    "entriesOf, itemsOf, literalText, literalFlag, initializerOf, unquoted",
  ],
  [
    "packages/adapter/typescript/src/resolve/invocationEffects.ts",
    "isImportedFrom, methodDeclaredIn, extractArg, inlineModuleBinding",
  ],
  [
    "packages/adapter/typescript/src/resolve/reachableClosure.ts",
    "resolveCallee, resolveJsxReference, recognizerOnlyRoots",
  ],
  [
    "packages/adapter/typescript/src/resolve/readName.ts",
    "isParameter, read, fromJoin, elementsOf, declarationOf, asCallable",
  ],
  [
    "packages/adapter/typescript/src/resolve/rethrowEnrichment.ts",
    "resolveCalleeSummary, functionFromDecl",
  ],
  [
    "packages/adapter/typescript/src/resolve/unfollowedCall.ts",
    "declarationsBehind",
  ],
  [
    "packages/adapter/typescript/src/shapes/fieldAccesses.ts",
    "findResponseAccessor, prefixOfMemberExpr",
  ],
  [
    "packages/adapter/typescript/src/shapes/shapes.ts",
    "extractShapeInner, shapeFromArrayLiteral, shapeFromObjectLiteral, propertyName",
  ],
  [
    "packages/adapter/typescript/src/subjects.ts",
    "resolveThenParameter, resolveSubject",
  ],
  [
    "packages/adapter/typescript/src/subUnitContext.ts",
    "findJsxAttributes, resolveAttributeValueFunction, tryExtractFunction, readArrayLiteralText",
  ],
  [
    "packages/adapter/typescript/src/terminals/extract.ts",
    "statusFromProperty, extractStatusCodeFromRule, extractBody",
  ],
  [
    "packages/adapter/typescript/src/terminals/helperResolution.ts",
    "memoizedLocalHelper, declarationsFor, asFunctionLike, bindArguments",
  ],
  ["packages/adapter/typescript/src/terminals/jsx.ts", "collectJsxAttributes"],
  [
    "packages/adapter/typescript/src/terminals/returns.ts",
    "terminalFromReturnedObject",
  ],
  [
    "packages/adapter/typescript/src/terminals/shared.ts",
    "parameterPositionOf",
  ],
  [
    "packages/adapter/typescript/src/terminals/statusBranches.ts",
    "asConditional",
  ],
  [
    "packages/adapter/typescript/src/terminals/throws.ts",
    "extractThrowMessage",
  ],
  [
    "packages/contract/storybook/src/index.ts",
    "extractMeta, findMetaObjectLiteral, unwrapToObjectLiteral, extractStories",
  ],
  [
    "packages/framework/aws-sqs/src/index.ts",
    "isSqsRecordIdentifier, extractDestructuredFields",
  ],
  [
    "packages/framework/cloudflare-workers/src/discovery.ts",
    "defaultExportTriggers, propertyName, functionOfProperty, functionBehind, declaredFunction, objectBehind, listenerAt",
  ],
  [
    "packages/framework/cloudflare-workers/src/envBindings.ts",
    "isTriggerEnvArgument, triggerReferences",
  ],
  [
    "packages/framework/cloudflare-workers/src/storeBindings.ts",
    "declaredInitializer, declaredTypeName, literalText",
  ],
  [
    "packages/framework/drizzle/src/index.ts",
    "isDrizzleReceiver, resolveTableName, tableNameFromDeclaration, objectKeys, objectProperty, valuesKeys",
  ],
  [
    "packages/framework/nextjs/src/serverActions.ts",
    "leadingDirectives, nextjsServerActions",
  ],
  ["packages/framework/react-query/src/index.ts", "callbackExpressionOf"],
  [
    "packages/runtime/node/src/envVars.ts",
    "bracketRead, literalBehind, callSitesOf, bindingRead, destructuredReads, functionBehindCallee",
  ],
  ["packages/adapter/python/src/decorators.ts", "argShapeOf"],
  ["packages/adapter/python/src/discovery.ts", "statusFromReturnedValue"],
  ["packages/adapter/python/src/paths/effects.ts", "the LITERAL_ARGS table"],
  ["packages/adapter/python/src/paths/predicates.ts", "valueRefOf"],
  [
    "packages/adapter/python/src/paths/returnedShape.ts",
    "recordShape, shapeOfReturned",
  ],
  ["packages/adapter/ruby/src/paths/effects.ts", "the LITERAL_ARGS table"],
  ["packages/adapter/ruby/src/paths/predicates.ts", "literalOf"],
  ["packages/adapter/ruby/src/storage.ts", "bareName"],
]);

function isUnder(relative, entry) {
  return relative === entry || relative.startsWith(`${entry}/`);
}

function sourceFilesUnder(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "__fixtures__" ||
        entry.name === "fixtures"
      ) {
        continue;
      }
      sourceFilesUnder(full, found);
      continue;
    }

    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(full);
    }
  }
  return found;
}

function probeApplies(probe, relative, treeSitterScopes) {
  if (probe.reads === "any") {
    return true;
  }

  const treeSitter = treeSitterScopes.some((scope) => isUnder(relative, scope));
  return probe.reads === "tree-sitter" ? treeSitter : !treeSitter;
}

function hitsIn(line, probe) {
  return probe.text === undefined
    ? probe.pattern.test(line)
    : line.includes(probe.text);
}

/**
 * Every place a second reader shows through, plus the exempt entries
 * whose file has gone, which are the ones to delete from the list.
 */
export function findSecondReaders({
  root,
  scopes = SCOPES,
  facility = FACILITY,
  probes = PROBES,
  exempt = EXEMPT,
  treeSitterScopes = TREE_SITTER_SCOPES,
}) {
  const offenses = [];
  const stillReading = new Set();
  for (const scope of scopes) {
    const dir = path.join(root, scope);
    if (!fs.existsSync(dir)) {
      offenses.push(`${scope}: scope directory is missing; update this script`);
      continue;
    }

    for (const file of sourceFilesUnder(dir, [])) {
      const relative = path.relative(root, file);
      if (facility.some((entry) => isUnder(relative, entry))) {
        continue;
      }

      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        for (const probe of probes) {
          if (
            !probeApplies(probe, relative, treeSitterScopes) ||
            !hitsIn(line, probe)
          ) {
            continue;
          }

          if (exempt.has(relative)) {
            stillReading.add(relative);
            continue;
          }

          const label = probe.label ?? probe.text;
          offenses.push(
            `${relative}:${index + 1}: ${probe.says} (\`${label}\`)`,
          );
        }
      }
    }
  }

  for (const [relative] of exempt) {
    if (!fs.existsSync(path.join(root, relative))) {
      offenses.push(`${relative}: exempt file is gone; drop its entry here`);
      continue;
    }

    if (!stillReading.has(relative)) {
      offenses.push(
        `${relative}: exempt file reads no syntax any more; drop its entry here`,
      );
    }
  }

  return offenses;
}

function main() {
  const offenses = findSecondReaders({ root: repoRoot });
  if (offenses.length > 0) {
    console.error(
      "A value is read through the evaluator or the resolution store, never off the syntax at the position.",
    );
    console.error(
      "See docs/internal/style.md#reading-a-value. Call the facility, or add an EXEMPT entry here with a reason:",
    );
    for (const offense of offenses) {
      console.error(`  - ${offense}`);
    }
    process.exit(1);
  }

  console.log("check:readers OK: one reader for a value.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
