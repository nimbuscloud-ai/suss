// namedExport.ts — discover code units exposed via specific named
// (or default) exports. The bread-and-butter discovery for frameworks
// that key off naming conventions (`loader`, `action` in React Router,
// `handler` in serverless toolchains, etc.).

import {
  type ArrowFunction,
  type FunctionExpression,
  Node,
  type SourceFile,
} from "ts-morph";

import { isWrittenAgain } from "../facts/assignments.js";
import { exportedDeclarationsOf } from "../moduleExports.js";
import {
  couldStillNameAFunction,
  type DiscoveredUnit,
  toFunctionRoot,
} from "./shared.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

/**
 * The name an expression states, when it states one. `export default
 * Panel` and `export default views.Panel` both say `Panel`, and a
 * function literal written at the export says nothing.
 */
function nameWrittenAt(expression: Node): string | null {
  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }
  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getName();
  }
  return null;
}

/**
 * Name a code unit discovered via `export default`. Prefers the
 * function's own identifier (`export default function UserCard() {}`
 * → `"UserCard"`) so component / handler identity survives. Falls
 * back to `"default"` for genuinely anonymous defaults
 * (`export default () => ...` or `export default function() {}`).
 */
function resolveDefaultExportName(decl: Node, fn: FunctionRoot): string {
  // FunctionDeclaration and named FunctionExpression both expose
  // getName(); ArrowFunction does not. Prefer the explicit name when
  // present.
  if (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn)) {
    const n = fn.getName?.();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }

  // `export default UserCard` — the declaration seen by the default-
  // export symbol resolver is the VariableDeclaration or the
  // referenced function. If we landed on a named VariableDeclaration,
  // use that name.
  if (Node.isVariableDeclaration(decl)) {
    const name = decl.getName();
    if (name.length > 0) {
      return name;
    }
  }

  // An arrow bound to a name carries that name, and asking the function
  // itself is what keeps the answer the same whichever module the
  // question came through. A barrel re-exporting the default of
  // `export const Panel = () => ...` would otherwise report `default`.
  const binding = fn.getParent();
  if (binding !== undefined && Node.isVariableDeclaration(binding)) {
    const name = binding.getName();
    if (name.length > 0) {
      return name;
    }
  }

  return "default";
}

export function discoverNamedExports(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "namedExport" }>,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];
  const names = new Set(match.names);
  // Which of the requested export names something was found under. The
  // unit's own name can differ from the name it was exported under, so
  // the last pass cannot ask the results what it still has to look for.
  const satisfied = new Set<string>();

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
    const func = toFunctionRoot(fn);
    if (func === null) {
      continue;
    }
    results.push({ func, kind, name });
    satisfied.add(name);
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

    // A name written again holds something else by the time anything
    // imports it, so the binding is the question and the rules answer
    // it. They come back with nothing when the writes cannot be
    // ordered, and nothing is the right answer there.
    if (isWrittenAgain(varDecl)) {
      const rewritten =
        resolution === undefined ? null : resolution.resolveCallable(varDecl);
      const fn = rewritten === null ? null : toFunctionRoot(rewritten);
      if (fn !== null) {
        results.push({ func: fn, kind, name });
        satisfied.add(name);
      }
      continue;
    }

    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      results.push({
        func: init as ArrowFunction | FunctionExpression,
        kind,
        name,
      });
      satisfied.add(name);
      continue;
    }

    // The export is a wrapper call, an imported name, or a .bind, so
    // ask the fact layer which function it comes down to. The unit is
    // still this export; only the body being read lives elsewhere.
    if (resolution !== undefined) {
      const resolved = resolution.resolveCallable(init);
      const fn = resolved === null ? null : toFunctionRoot(resolved);
      if (fn !== null) {
        results.push({ func: fn, kind, name });
        satisfied.add(name);
      }
    }
  }

  // 3. export default function UserCard() {} — name "UserCard"
  //    export default function() {}          — name "default"
  //    export default UserCard               — name from the referenced binding
  //    export default () => ...              — name "default"
  //
  // Prefer the function's own name when it has one. For components
  // especially, the function name is the component identity; losing
  // it to "default" would collapse every file's default export into
  // the same name across the workspace.
  if (names.has("default")) {
    const units = defaultExportUnits(sourceFile, kind, resolution);
    results.push(...units);
    if (units.length > 0) {
      satisfied.add("default");
    }
  }

  // 4. export { loader } re-export or any other form
  // Use the exported-declarations map for names we haven't already found
  for (const targetName of names) {
    if (satisfied.has(targetName)) {
      continue;
    }

    const exported = exportedDeclarationsOf(sourceFile).get(targetName);
    if (exported === undefined) {
      continue;
    }

    for (const decl of exported) {
      // A name whose declaration is not itself a function is a name
      // standing for one somewhere else, so the fact layer is asked
      // which. Taking a container apart is the shape that arrives here:
      // `const { handler } = holder` declares the name on a binding
      // element and there is no function written at it.
      const fn =
        toFunctionRoot(decl) ??
        (resolution === undefined
          ? null
          : resolutionToFunctionRoot(resolution, decl));
      if (fn !== null) {
        results.push({
          func: fn,
          kind,
          name:
            targetName === "default"
              ? resolveDefaultExportName(decl, fn)
              : targetName,
        });
        break;
      }
    }
  }

  return results;
}

/**
 * The units `export default` puts on the module's surface.
 *
 * A default export names its unit twice over: `default` is the route
 * out of the module, and the expression written at it says what left.
 * The unit takes its name from the expression, so `export default
 * Panel` and `export default views.Panel` both report `Panel`, and only
 * a function written at the export with no name of its own falls back
 * to `default`.
 */
function defaultExportUnits(
  sourceFile: SourceFile,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  for (const assignment of sourceFile.getExportAssignments()) {
    if (assignment.isExportEquals()) {
      continue;
    }
    const expression = assignment.getExpression();
    const written = toFunctionRoot(expression);
    const resolved =
      written ??
      (resolution === undefined
        ? null
        : resolutionToFunctionRoot(resolution, expression));
    if (resolved === null) {
      return [];
    }
    const name =
      nameWrittenAt(expression) ??
      resolveDefaultExportName(expression, resolved);
    return [{ func: resolved, kind, name }];
  }

  // No `export default <expression>`, so the default is a declaration
  // carrying the modifier, or a name re-exported from another module.
  const defaultExport = sourceFile.getDefaultExportSymbol();
  if (defaultExport === undefined) {
    return [];
  }
  const units: DiscoveredUnit[] = [];
  for (const decl of defaultExport.getDeclarations()) {
    const fn = toFunctionRoot(decl);
    if (fn !== null) {
      units.push({ func: fn, kind, name: resolveDefaultExportName(decl, fn) });
    }
  }
  return units;
}

/**
 * The function a value comes down to, asked only of names that could
 * still be one. Most default exports are objects, schemas or constants,
 * and asking about those walks a file's import closure for an answer
 * that was always going to be null.
 */
function resolutionToFunctionRoot(
  resolution: ResolutionStore,
  value: Node,
): FunctionRoot | null {
  if (!couldStillNameAFunction(value)) {
    return null;
  }
  const resolved = resolution.resolveCallable(value);
  return resolved === null ? null : toFunctionRoot(resolved);
}
