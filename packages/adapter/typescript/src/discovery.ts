// discovery.ts — Code unit discovery for ts-morph SourceFiles (Task 2.4)

import {
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  type SourceFile,
} from "ts-morph";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Public output type
// ---------------------------------------------------------------------------

export interface DiscoveredUnit {
  func: FunctionRoot;
  kind: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract FunctionRoot from something that might be a function or wrap one. */
function toFunctionRoot(node: Node): FunctionRoot | null {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
  ) {
    return node as FunctionRoot;
  }

  return null;
}

// ---------------------------------------------------------------------------
// namedExport discovery
// ---------------------------------------------------------------------------

function discoverNamedExports(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "namedExport" }>,
  kind: string,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];
  const names = new Set(match.names);

  // 1. export function loader() {}
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) {
      continue;
    }
    const name = fn.getName();
    if (name === undefined) {
      continue;
    }
    if (!names.has(name)) {
      continue;
    }
    results.push({ func: fn as FunctionDeclaration, kind, name });
  }

  // 2. export const loader = () => {} / export const loader = function() {}
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const name = varDecl.getName();
    if (!names.has(name)) {
      continue;
    }

    // Check if the variable statement is exported
    const varStatement = varDecl.getVariableStatement();
    if (varStatement === undefined) {
      continue;
    }
    if (!varStatement.isExported()) {
      continue;
    }

    const init = varDecl.getInitializer();
    if (init === undefined) {
      continue;
    }

    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      results.push({
        func: init as ArrowFunction | FunctionExpression,
        kind,
        name,
      });
    }
  }

  // 3. export default function() {} — name "default"
  if (names.has("default")) {
    const defaultExport = sourceFile.getDefaultExportSymbol();
    if (defaultExport !== undefined) {
      const decls = defaultExport.getDeclarations();
      for (const decl of decls) {
        const fn = toFunctionRoot(decl);
        if (fn !== null) {
          results.push({ func: fn, kind, name: "default" });
        }
      }
    }
  }

  // 4. export { loader } re-export or any other form
  // Use getExportedDeclarations for names we haven't already found
  const alreadyFound = new Set(results.map((r) => r.name));
  for (const targetName of names) {
    if (alreadyFound.has(targetName)) {
      continue;
    }

    const exported = sourceFile.getExportedDeclarations().get(targetName);
    if (exported === undefined) {
      continue;
    }

    for (const decl of exported) {
      const fn = toFunctionRoot(decl);
      if (fn !== null) {
        results.push({ func: fn, kind, name: targetName });
        break;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// registrationCall discovery
// ---------------------------------------------------------------------------

function discoverRegistrationCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "registrationCall" }>,
  kind: string,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];

  // Step 1: Find the import declaration
  let importedLocalName: string | null = null;

  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.getModuleSpecifierValue() !== match.importModule) {
      continue;
    }

    // Named import
    for (const namedImport of importDecl.getNamedImports()) {
      if (
        namedImport.getName() === match.importName ||
        namedImport.getAliasNode()?.getText() === match.importName
      ) {
        importedLocalName =
          namedImport.getAliasNode()?.getText() ?? namedImport.getName();
        break;
      }
    }

    if (importedLocalName !== null) {
      break;
    }

    // Default import
    const defaultImport = importDecl.getDefaultImport();
    if (
      defaultImport !== undefined &&
      defaultImport.getText() === match.importName
    ) {
      importedLocalName = defaultImport.getText();
      break;
    }

    // Namespace import
    const namespaceImport = importDecl.getNamespaceImport();
    if (
      namespaceImport !== undefined &&
      namespaceImport.getText() === match.importName
    ) {
      importedLocalName = namespaceImport.getText();
      break;
    }
  }

  if (importedLocalName === null) {
    return results;
  }

  // Step 2: Find what variable holds the result of calling the imported function
  // e.g. const s = initServer(); or const router = Router();
  const registrationVarNames = new Set<string>();

  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const init = varDecl.getInitializer();
    if (init === undefined) {
      continue;
    }

    // Might be: initServer() or new Router() etc.
    let calleeText: string | null = null;
    if (Node.isCallExpression(init)) {
      calleeText = init.getExpression().getText();
    } else if (Node.isNewExpression(init)) {
      calleeText = init.getExpression().getText();
    }

    if (calleeText === importedLocalName) {
      registrationVarNames.add(varDecl.getName());
    }
  }

  // Step 3: Walk all call expressions and match registration chains
  const registrationMethods = match.registrationChain.map((c) =>
    c.startsWith(".") ? c.slice(1) : c,
  );

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) {
      return;
    }

    const methodName = callee.getName();
    if (!registrationMethods.includes(methodName)) {
      return;
    }

    // The subject of the call must resolve to our registration variable
    const subject = callee.getExpression();
    let subjectName: string | null = null;

    if (Node.isIdentifier(subject)) {
      subjectName = subject.getText();
    }

    if (subjectName === null || !registrationVarNames.has(subjectName)) {
      return;
    }

    // Step 4: Extract handlers from the call
    const args = node.getArguments();

    // ts-rest style: second arg is object literal with handler methods
    let foundObjectArg = false;
    for (const arg of args) {
      if (!Node.isObjectLiteralExpression(arg)) {
        continue;
      }

      foundObjectArg = true;
      for (const prop of arg.getProperties()) {
        // Method shorthand: { async getUser() { ... } }
        if (Node.isMethodDeclaration(prop)) {
          results.push({
            func: prop as MethodDeclaration,
            kind,
            name: prop.getName(),
          });
          continue;
        }

        if (!Node.isPropertyAssignment(prop)) {
          continue;
        }

        const propInit = prop.getInitializer();
        if (propInit === undefined) {
          continue;
        }

        if (
          Node.isArrowFunction(propInit) ||
          Node.isFunctionExpression(propInit)
        ) {
          results.push({
            func: propInit as ArrowFunction | FunctionExpression,
            kind,
            name: prop.getName(),
          });
        }
      }
    }

    if (!foundObjectArg) {
      // Express style: last arg is a function
      const lastArg = args[args.length - 1] as Node | undefined;
      if (lastArg !== undefined) {
        if (
          Node.isArrowFunction(lastArg) ||
          Node.isFunctionExpression(lastArg)
        ) {
          results.push({
            func: lastArg as ArrowFunction | FunctionExpression,
            kind,
            name: methodName,
          });
        }
      }
    }
  });

  return results;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Discover code units in `sourceFile` by running all patterns.
 * Deduplicates entries with the same function node and kind.
 */
export function discoverUnits(
  sourceFile: SourceFile,
  patterns: DiscoveryPattern[],
): DiscoveredUnit[] {
  const allResults: DiscoveredUnit[] = [];

  for (const pattern of patterns) {
    let found: DiscoveredUnit[] = [];

    if (pattern.match.type === "namedExport") {
      found = discoverNamedExports(sourceFile, pattern.match, pattern.kind);
    } else if (pattern.match.type === "registrationCall") {
      found = discoverRegistrationCalls(
        sourceFile,
        pattern.match,
        pattern.kind,
      );
    } else if (pattern.match.type === "decorator") {
      // stub
      found = [];
    } else if (pattern.match.type === "fileConvention") {
      // stub
      found = [];
    }

    allResults.push(...found);
  }

  // Deduplicate: same node + same kind → keep first occurrence
  const seen = new Set<string>();
  const deduped: DiscoveredUnit[] = [];

  for (const unit of allResults) {
    const key = `${unit.func.getStart()}-${unit.func.getEnd()}-${unit.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(unit);
    }
  }

  return deduped;
}
