/**
 * Finds the component an app boots with, from calls such as
 * `createRoot(el).render(<App />)`. That component is often exported by
 * nothing, so the export walk misses it. The closure follows its JSX
 * references from here, which makes the rest of the app reachable.
 */

import { Node } from "ts-morph";

import {
  functionTargetOf,
  importedNamesOf,
  importedRootsOf,
} from "@suss/adapter-typescript";

import type { DiscoveredCustomUnit, PatternPack } from "@suss/extractor";
import type { CallExpression, Identifier, SourceFile } from "ts-morph";

const BOOT_CALLEES = ["createRoot", "hydrateRoot"];
const BOOT_MODULES = ["react-dom/client", "react-dom"];

function importedBootNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const [local, canonical] of importedNamesOf(sourceFile, BOOT_MODULES)) {
    if (BOOT_CALLEES.includes(canonical)) {
      names.add(local);
    }
  }
  return names;
}

/** For `ReactDOM.render`, with react-dom imported as a namespace or default. */
function importedDomNamespaces(sourceFile: SourceFile): Set<string> {
  return importedRootsOf(sourceFile, BOOT_MODULES);
}

function isBootRender(
  call: CallExpression,
  bootNames: Set<string>,
  domNamespaces: Set<string>,
): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    // Both boot forms read here call a `.render` property:
    // `createRoot(el).render(...)` and `ReactDOM.render(...)`.
    return false;
  }
  if (callee.getName() !== "render") {
    return false;
  }
  const base = callee.getExpression();
  if (Node.isCallExpression(base)) {
    const inner = base.getExpression();
    return Node.isIdentifier(inner) && bootNames.has(inner.getText());
  }
  return Node.isIdentifier(base) && domNamespaces.has(base.getText());
}

function renderedComponentOf(
  call: CallExpression,
): { func: unknown; name: string } | null {
  const argument = call.getArguments()[0];
  if (argument === undefined) {
    return null;
  }
  let tag: Identifier | null = null;
  if (Node.isJsxSelfClosingElement(argument)) {
    const node = argument.getTagNameNode();
    tag = Node.isIdentifier(node) ? node : null;
  } else if (Node.isJsxElement(argument)) {
    const node = argument.getOpeningElement().getTagNameNode();
    tag = Node.isIdentifier(node) ? node : null;
  }
  if (tag === null || !/^[A-Z]/.test(tag.getText())) {
    return null;
  }
  const target = functionTargetOf(tag);
  return target === null ? null : { func: target.func, name: target.name };
}

export const reactRootComponents: NonNullable<PatternPack["discoverUnits"]> = (
  sourceFile,
  _ctx,
) => {
  const sf = sourceFile as SourceFile;
  const text = sf.getFullText();
  if (!text.includes("render")) {
    return [];
  }

  const bootNames = importedBootNames(sf);
  const domNamespaces = importedDomNamespaces(sf);
  if (bootNames.size === 0 && domNamespaces.size === 0) {
    return [];
  }

  const out: DiscoveredCustomUnit[] = [];
  const claimed = new Set<unknown>();
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    if (!isBootRender(node, bootNames, domNamespaces)) {
      return;
    }
    const component = renderedComponentOf(node);
    if (component !== null && !claimed.has(component.func)) {
      claimed.add(component.func);
      out.push({
        func: component.func,
        kind: "component",
        name: component.name,
      });
    }
  });
  return out;
};
