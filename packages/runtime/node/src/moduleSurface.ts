/**
 * Reads of the module globals `__dirname`, `__filename` and
 * `import.meta`. Each read becomes a metadata read named by its source
 * text, so a unit that depends on its own file location shows that in
 * its summary.
 *
 * `require()` and `require.resolve()` are left out for now, because
 * they overlap with import resolution.
 */

import { Node, type PropertyAccessExpression } from "ts-morph";

import { opaqueRuntimeRead } from "./configBinding.js";

import type { AccessRecognizer } from "@suss/extractor";

const FILE_LOCATION_GLOBALS = new Set(["__dirname", "__filename"]);

/** Recognizes `import.meta.url` and any other `import.meta.X` read. */
export const importMetaRecognizer: AccessRecognizer = (access, _ctx) => {
  const node = access as Node;
  if (!Node.isPropertyAccessExpression(node)) {
    return null;
  }
  const inner = node.getExpression();
  // TypeScript parses `import.meta` as a MetaProperty node.
  if (!Node.isMetaProperty(inner)) {
    return null;
  }
  const keyword = inner.getKeywordToken();
  // `new.target` is the other MetaProperty, and its name is `target`.
  if (keyword === undefined || inner.getNameNode().getText() !== "meta") {
    return null;
  }
  return [opaqueRuntimeRead(node.getText())];
};

/**
 * Recognizes `__dirname` or `__filename` as the receiver of a property
 * access, as in `__dirname.length`. Access recognizers never run on a
 * bare identifier, so a read such as `const dir = __dirname` needs
 * `findBareFileLocationGlobals`.
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
  return [opaqueRuntimeRead(text)];
};

/**
 * Finds every read of `__dirname` or `__filename` under `parent`,
 * including nested functions, and skips a property named the same way,
 * as in `obj.__dirname`.
 *
 * Extraction never calls this. The adapter has no hook for recognizing
 * a bare identifier, so a caller that wants these reads has to call it
 * directly.
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
      // Nested functions are walked too. The caller picks the scope.
    }
    if (!Node.isIdentifier(node)) {
      return;
    }
    const text = node.getText();
    if (!FILE_LOCATION_GLOBALS.has(text)) {
      return;
    }
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
