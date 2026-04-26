// factoryTracking.ts — walk variable declarations to discover bindings
// whose values trace back to a tracked import. Used by packageImport
// discovery to attribute method calls on factory results / class
// instances to the originating export.
//
// Recognized initializer shapes (await wrapper peeled either way):
//   const x = factory(...)       // call
//   const x = new Class(...)     // new
//   const x = await factory(...) // awaited call
//   const x = await new Class(...) // awaited new (rare but legal)
//
// Recognized LHS shapes:
//   const x = ...                  // identifier binding
//   const { method } = ...         // plain destructure
//   const { method: alias } = ...  // aliased destructure
//
// Bindings are scoped to their enclosing function (or to the source
// file at top level). `resolve(name, fromNode)` walks outward through
// enclosing scopes — a binding declared in `outer` is visible from
// `inner` when looked up from inside `inner`'s body (closure capture).
//
// Out of scope: array destructuring, nested destructuring, default
// values, reassignments, function-parameter passthrough. See
// project_packageimport_gaps.md.

import { Node, type SourceFile, SyntaxKind } from "ts-morph";

export interface FactoryProvenance {
  packageName: string;
  exportPath: string[];
}

export interface ScopedBindingTable {
  /**
   * Resolve a binding name as visible from `fromNode`, walking
   * outward through enclosing function / file scopes. Returns the
   * innermost matching binding or null when no scope binds the name.
   */
  resolve(name: string, fromNode: Node): FactoryProvenance | null;
}

function isScopeNode(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

export function trackFactoryBindings(
  sourceFile: SourceFile,
  recognize: (
    callee: Node,
    isNewExpression: boolean,
  ) => FactoryProvenance | null,
): ScopedBindingTable {
  // Per-scope binding maps. The scope key is either the enclosing
  // function-shaped node or the source file (for top-level bindings).
  const scopes = new Map<Node, Map<string, FactoryProvenance>>();

  function scopeOf(node: Node): Node {
    let current = node.getParent();
    while (current !== undefined) {
      if (isScopeNode(current)) {
        return current;
      }
      current = current.getParent();
    }
    return sourceFile;
  }

  function record(
    scope: Node,
    name: string,
    provenance: FactoryProvenance,
  ): void {
    let map = scopes.get(scope);
    if (map === undefined) {
      map = new Map();
      scopes.set(scope, map);
    }
    map.set(name, provenance);
  }

  // getVariableDeclarations() returns only top-level declarations.
  // Use the descendant variant to pick up bindings inside function
  // bodies — the realistic location for factory-result vars.
  for (const varDecl of sourceFile.getDescendantsOfKind(
    SyntaxKind.VariableDeclaration,
  )) {
    const init = varDecl.getInitializer();
    if (init === undefined) {
      continue;
    }

    const peeled = Node.isAwaitExpression(init) ? init.getExpression() : init;

    let callee: Node;
    let isNew: boolean;
    if (Node.isCallExpression(peeled)) {
      callee = peeled.getExpression();
      isNew = false;
    } else if (Node.isNewExpression(peeled)) {
      const expr = peeled.getExpression();
      if (expr === undefined) {
        continue;
      }
      callee = expr;
      isNew = true;
    } else {
      continue;
    }

    const provenance = recognize(callee, isNew);
    if (provenance === null) {
      continue;
    }

    const scope = scopeOf(varDecl);

    const nameNode = varDecl.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      record(scope, nameNode.getText(), provenance);
      continue;
    }
    if (Node.isObjectBindingPattern(nameNode)) {
      for (const elem of nameNode.getElements()) {
        // Skip rest elements (`const { ...rest } = ...`) — provenance
        // of a rest object isn't expressible as a single exportPath.
        if (elem.getDotDotDotToken() !== undefined) {
          continue;
        }
        const propNode = elem.getPropertyNameNode();
        const propName =
          propNode !== undefined ? propNode.getText() : elem.getName();
        const localName = elem.getName();
        record(scope, localName, {
          packageName: provenance.packageName,
          exportPath: [...provenance.exportPath, propName],
        });
      }
    }
    // ArrayBindingPattern intentionally not handled — out of v0 scope.
  }

  return {
    resolve(name: string, fromNode: Node): FactoryProvenance | null {
      let current: Node | undefined = fromNode;
      while (current !== undefined) {
        const map = scopes.get(current);
        if (map !== undefined) {
          const found = map.get(name);
          if (found !== undefined) {
            return found;
          }
        }
        current = current.getParent();
      }
      return null;
    },
  };
}
