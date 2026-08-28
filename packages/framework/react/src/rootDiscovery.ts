/**
 * Root-walk discovery: the component an app boots with.
 *
 * `createRoot(el).render(<App/>)` renders a component no export
 * heuristic has to find, and an App wired this way was invisible when
 * nothing exported it. This walk reads the boot calls React ships
 * (`createRoot` and `hydrateRoot` from react-dom/client, and
 * `ReactDOM.render`), resolves the rendered element's component to
 * its declaration, and emits it as a component unit. The closure then
 * follows its JSX references, so everything the app actually renders
 * is reachable from here.
 */

import { Node } from "ts-morph";

import type { DiscoveredCustomUnit, PatternPack } from "@suss/extractor";
import type { CallExpression, Identifier, SourceFile } from "ts-morph";

const BOOT_CALLEES = ["createRoot", "hydrateRoot"];
const BOOT_MODULES = ["react-dom/client", "react-dom"];

function importedBootNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const decl of sourceFile.getImportDeclarations()) {
    if (!BOOT_MODULES.includes(decl.getModuleSpecifierValue())) {
      continue;
    }
    for (const named of decl.getNamedImports()) {
      if (BOOT_CALLEES.includes(named.getName())) {
        names.add(named.getAliasNode()?.getText() ?? named.getName());
      }
    }
  }
  return names;
}

/** Namespace and default imports of react-dom, for `ReactDOM.render`. */
function importedDomNamespaces(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const decl of sourceFile.getImportDeclarations()) {
    if (!BOOT_MODULES.includes(decl.getModuleSpecifierValue())) {
      continue;
    }
    const namespace = decl.getNamespaceImport()?.getText();
    if (namespace !== undefined) {
      names.add(namespace);
    }
    const defaultImport = decl.getDefaultImport()?.getText();
    if (defaultImport !== undefined) {
      names.add(defaultImport);
    }
  }
  return names;
}

function isBootRender(
  call: CallExpression,
  bootNames: Set<string>,
  domNamespaces: Set<string>,
): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) {
    // ReactDOM.render's older positional form aside, every boot render
    // goes through a `.render` property.
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

/** The component the rendered element refers to, as its declaration. */
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

  const symbol = tag.getSymbol();
  const aliased = symbol?.getAliasedSymbol();
  for (const decl of (aliased ?? symbol)?.getDeclarations() ?? []) {
    if (Node.isFunctionDeclaration(decl) && decl.getBody() !== undefined) {
      return { func: decl, name: decl.getName() ?? tag.getText() };
    }
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (
        init !== undefined &&
        (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
      ) {
        return { func: init, name: decl.getName() };
      }
    }
  }
  return null;
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
