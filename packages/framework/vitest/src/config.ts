/**
 * Whether a project's vitest config turns on `test.globals`, which lets a
 * test call `describe`, `it` and `vi` without importing them. vitest
 * looks for `vitest.config.*` and then `vite.config.*` in the directory
 * it runs from, unless a script in `package.json` hands it another with
 * `--config`, as a project with a unit and an integration setup does.
 * This reads all of those. Only a `globals: true` written inside a
 * `test` object counts, so a value read from the environment or built by
 * a function leaves the setting off.
 */

import fs from "node:fs";
import path from "node:path";

import { ts } from "ts-morph";

const CONFIG_NAMES = ["vitest.config", "vite.config"];
const EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** `--config <file>`, `--config=<file>` or `-c <file>` in a script that runs vitest, the file quoted or not. */
const CONFIG_FLAG =
  /(?:--config|-c)(?:=|\s+)(?:"(?<double>[^"]+)"|'(?<single>[^']+)'|(?<bare>[^\s;&|"']+))/g;

/** The directory a run reads, and the config the pack was told to read there, if any. */
export interface ConfigPlace {
  directory: string;
  config?: string | undefined;
}

/**
 * Every file whose text decides whether globals are on, present or not:
 * the config the pack was told to read, or else `package.json` and each
 * config vitest could read. Editing or adding any of them changes the
 * answer.
 */
export function configInputs({ directory, config }: ConfigPlace): string[] {
  if (config !== undefined) {
    return [path.resolve(directory, config)];
  }
  return [
    path.join(directory, "package.json"),
    ...defaultConfigs(directory),
    ...configsPassedByScripts(directory),
  ];
}

/** Whether a config vitest reads there sets `test.globals`. */
export function configSetsGlobals(place: ConfigPlace): boolean {
  const byDefault = defaultConfigs(place.directory).find((one) =>
    fs.existsSync(one),
  );
  const read =
    place.config !== undefined
      ? configInputs(place)
      : [
          ...(byDefault === undefined ? [] : [byDefault]),
          ...configsPassedByScripts(place.directory),
        ];
  return read
    .filter((file) => fs.existsSync(file))
    .some((file) => setsGlobals(parsed(file)));
}

function defaultConfigs(directory: string): string[] {
  return CONFIG_NAMES.flatMap((name) =>
    EXTENSIONS.map((extension) => path.join(directory, `${name}${extension}`)),
  );
}

/** The configs the project's scripts pass to vitest, resolved against `directory`. */
function configsPassedByScripts(directory: string): string[] {
  let scripts: unknown;
  try {
    scripts = JSON.parse(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    ).scripts;
  } catch {
    return [];
  }
  if (scripts === null || typeof scripts !== "object") {
    return [];
  }
  return Object.values(scripts)
    .filter(
      (script): script is string =>
        typeof script === "string" && script.includes("vitest"),
    )
    .flatMap((script) => [...script.matchAll(CONFIG_FLAG)])
    .map((found) => {
      const { double, single, bare } = found.groups ?? {};
      return path.resolve(directory, double ?? single ?? bare ?? "");
    });
}

function parsed(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function setsGlobals(node: ts.Node): boolean {
  if (
    ts.isPropertyAssignment(node) &&
    propertyName(node) === "globals" &&
    node.initializer.kind === ts.SyntaxKind.TrueKeyword &&
    ts.isObjectLiteralExpression(node.parent) &&
    ts.isPropertyAssignment(node.parent.parent) &&
    propertyName(node.parent.parent) === "test"
  ) {
    return true;
  }
  return ts.forEachChild(node, setsGlobals) === true;
}

function propertyName(node: ts.PropertyAssignment): string | null {
  const name = node.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}
