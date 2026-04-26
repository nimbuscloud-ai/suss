// moduleSurface.ts — recognize reads of module-loading globals that
// aren't expressible as imports: `__dirname`, `__filename`,
// `import.meta.url`. Each becomes a runtime-metadata read with the
// callee's source text, so units depending on file location surface
// the dependency without inventing structural shapes.
//
// Bare `require()` and `require.resolve()` aren't handled here —
// they overlap with the import-resolution pipeline and are deferred
// per the design doc.

import { Node, type PropertyAccessExpression } from "ts-morph";

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";

const FILE_LOCATION_GLOBALS = new Set(["__dirname", "__filename"]);

function moduleMetaRead(callee: string): Effect {
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: "@suss/runtime-node",
      deploymentTarget: "lambda",
      instanceName: "<runtime>",
    }),
    callee,
    interaction: {
      class: "config-read",
      name: callee,
      defaulted: false,
    },
  };
}

/**
 * accessRecognizer for `import.meta.url` (and other `import.meta.X`
 * properties). The recognizer fires on PropertyAccessExpression
 * nodes whose receiver chain ends at `import.meta`.
 */
export const importMetaRecognizer: AccessRecognizer = (access, _ctx) => {
  const node = access as Node;
  if (!Node.isPropertyAccessExpression(node)) {
    return null;
  }
  const inner = node.getExpression();
  // `import.meta` parses as a MetaProperty, not a regular
  // PropertyAccess. ts-morph exposes it via Node.isMetaProperty.
  if (!Node.isMetaProperty(inner)) {
    return null;
  }
  const keyword = inner.getKeywordToken();
  // The keyword token text is "import" for the only meta-property
  // shape we care about.
  if (keyword === undefined || inner.getNameNode().getText() !== "meta") {
    return null;
  }
  return [moduleMetaRead(node.getText())];
};

/**
 * Walks an Identifier node looking for the bare globals
 * `__dirname` / `__filename`. Returns a runtime-config-shaped
 * interaction effect for each match.
 *
 * accessRecognizers fire on PropertyAccessExpression nodes; bare
 * identifier reads need a different mechanism. The pack exposes a
 * helper (`findFileLocationGlobals`) that any consumer can call to
 * scan a source file directly. The pack's main use case is during
 * extraction where the adapter walks expressions; we synthesize the
 * detection by piggybacking on the property-access recognizer when
 * the global is the receiver of a property access (`__dirname.length`)
 * — bare reads (`const dir = __dirname`) need a separate surface.
 *
 * For v0 we recognize both: as a property-access receiver (above) and
 * as a bare identifier reference via a complementary helper.
 */
export const fileLocationRecognizer: AccessRecognizer = (access, _ctx) => {
  const node = access as Node;
  if (!Node.isPropertyAccessExpression(node)) {
    return null;
  }
  const subject = node.getExpression();
  if (!Node.isIdentifier(subject)) {
    return null;
  }
  const text = subject.getText();
  if (!FILE_LOCATION_GLOBALS.has(text)) {
    return null;
  }
  return [moduleMetaRead(text)];
};

/**
 * Recognize bare identifier reads of `__dirname` / `__filename`.
 * Walks the source file directly for IdentifierExpression nodes that
 * aren't part of a containing PropertyAccess (those are caught by
 * `fileLocationRecognizer`). Used by the pack's bareGlobalsScanner
 * in invocationRecognizers via the adapter's call walk; we don't
 * have an identifier recognizer hook today.
 *
 * Note: this DOES NOT fire as part of normal recognizer dispatch
 * because the adapter has no IdentifierRecognizer. Consumers
 * needing bare-identifier coverage call the helper directly. A
 * future addition of an identifierRecognizer hook would let the
 * pack participate in the standard flow without this side door.
 */
export function findBareFileLocationGlobals(
  parent: Node,
): Array<{ name: string; node: Node }> {
  const out: Array<{ name: string; node: Node }> = [];
  parent.forEachDescendant((node, traversal) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isArrowFunction(node) ||
      Node.isMethodDeclaration(node)
    ) {
      // Walking nested functions is fine — they're separate units.
      // Don't skip — caller decides scope.
    }
    if (!Node.isIdentifier(node)) {
      return;
    }
    const text = node.getText();
    if (!FILE_LOCATION_GLOBALS.has(text)) {
      return;
    }
    // Skip when this identifier is the *property* part of a
    // PropertyAccessExpression (e.g. `obj.__dirname` — different
    // meaning) or its declaration site.
    const parentNode = node.getParent();
    if (parentNode === undefined) {
      return;
    }
    if (
      Node.isPropertyAccessExpression(parentNode) &&
      (parentNode as PropertyAccessExpression).getNameNode() === node
    ) {
      return;
    }
    out.push({ name: text, node });
  });
  return out;
}
