/**
 * Where a project's Prisma generators write the client, read from the
 * project's own schema.
 *
 * Prisma 7's `prisma-client` generator writes no copy of the schema
 * beside the client, so the directory has nothing in it the pack could
 * recognize, and before `prisma generate` runs it does not exist at all.
 * The schema's generator blocks say where it goes. The schema is found
 * where Prisma looks for it: the `schema` a `prisma.config.ts` gives,
 * the `prisma.schema` key in package.json, then `prisma/schema.prisma`
 * and `schema.prisma`. A schema path may be a directory of `.prisma`
 * files. An `output` is relative to the file that declares it.
 */

import fs from "node:fs";
import path from "node:path";

import { getSchema } from "@mrleebo/prisma-ast";
import { ts } from "ts-morph";

const CONFIG_FILES = [
  "prisma.config.ts",
  "prisma.config.mts",
  "prisma.config.cts",
  "prisma.config.js",
  "prisma.config.mjs",
  "prisma.config.cjs",
  path.join(".config", "prisma.ts"),
];

const DEFAULT_SCHEMAS = [path.join("prisma", "schema.prisma"), "schema.prisma"];

interface ReadProject {
  dirs: readonly string[];
  /** The files the answer was read from, with when each last changed. */
  readFrom: ReadonlyMap<string, number>;
}

// A long-lived process such as the MCP server extracts many times, so an
// answer is kept only while none of the files it came from has changed.
const readProjects = new Map<string, ReadProject>();

/**
 * The directories the generators of the project containing `fromDir`
 * write to, as absolute paths. The project is the nearest directory up
 * from `fromDir` with a package.json or a Prisma config in it.
 */
export function generatedClientDirs(fromDir: string): readonly string[] {
  const root = projectRootOf(fromDir);
  if (root === null) {
    return [];
  }
  const known = readProjects.get(root);
  if (known !== undefined && unchanged(known.readFrom)) {
    return known.dirs;
  }
  const schemaFiles = schemaFilesOf(root);
  const readFrom = new Map<string, number>();
  for (const file of [...projectFilesOf(root), ...schemaFiles]) {
    readFrom.set(file, changedAt(file));
  }
  const dirs = schemaFiles.flatMap(outputDirsIn);
  readProjects.set(root, { dirs, readFrom });
  return dirs;
}

/** Whether a file is in a directory a generator of its own project writes to. */
export function isInGeneratedClient(filePath: string): boolean {
  return generatedClientDirs(path.dirname(filePath)).some((dir) =>
    filePath.startsWith(`${dir}${path.sep}`),
  );
}

/** The files that decide where the schema is, whether or not each exists. */
function projectFilesOf(root: string): string[] {
  return [
    path.join(root, "package.json"),
    ...CONFIG_FILES.map((name) => path.join(root, name)),
    ...DEFAULT_SCHEMAS.map((name) => path.join(root, name)),
  ];
}

function changedAt(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function unchanged(readFrom: ReadonlyMap<string, number>): boolean {
  for (const [file, at] of readFrom) {
    if (changedAt(file) !== at) {
      return false;
    }
  }
  return true;
}

function projectRootOf(fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  while (true) {
    if (
      fs.existsSync(path.join(dir, "package.json")) ||
      configFileIn(dir) !== null
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function configFileIn(dir: string): string | null {
  for (const name of CONFIG_FILES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** The schema files of the project at `root`, from the first place that has one. */
function schemaFilesOf(root: string): string[] {
  const stated = [configuredSchema(root), packageJsonSchema(root)];
  for (const schema of [
    ...stated.filter((one): one is string => one !== null),
    ...DEFAULT_SCHEMAS.map((name) => path.join(root, name)),
  ]) {
    const files = prismaFilesAt(schema);
    if (files.length > 0) {
      return files;
    }
  }
  return [];
}

function prismaFilesAt(schemaPath: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(schemaPath);
  } catch {
    return [];
  }
  if (stat.isFile()) {
    return [schemaPath];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(schemaPath, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".prisma"))
    .map((name) => path.join(schemaPath, name))
    .sort();
}

/**
 * The `schema` a Prisma config file gives, when it writes the path as a
 * string. A computed path falls through to the places Prisma looks by
 * default.
 */
function configuredSchema(root: string): string | null {
  const config = configFileIn(root);
  if (config === null) {
    return null;
  }
  const source = ts.createSourceFile(
    config,
    fs.readFileSync(config, "utf8"),
    ts.ScriptTarget.Latest,
  );
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (found !== null) {
      return;
    }
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "schema" &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      found = node.initializer.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found === null ? null : path.resolve(root, found);
}

function packageJsonSchema(root: string): string | null {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as {
      prisma?: { schema?: unknown };
    };
    const schema = manifest.prisma?.schema;
    return typeof schema === "string" ? path.resolve(root, schema) : null;
  } catch {
    return null;
  }
}

/** The `output` of every generator block in one schema file. */
function outputDirsIn(schemaFile: string): string[] {
  let list: unknown[];
  try {
    list = (
      getSchema(fs.readFileSync(schemaFile, "utf8")) as { list: unknown[] }
    ).list;
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const block of list) {
    const output = generatorOutput(block);
    if (output !== null) {
      dirs.push(path.resolve(path.dirname(schemaFile), output));
    }
  }
  return dirs;
}

function generatorOutput(block: unknown): string | null {
  const generator = block as {
    type?: string;
    assignments?: Array<{ type?: string; key?: string; value?: unknown }>;
  };
  if (generator.type !== "generator") {
    return null;
  }
  for (const assignment of generator.assignments ?? []) {
    if (
      assignment.type === "assignment" &&
      assignment.key === "output" &&
      typeof assignment.value === "string"
    ) {
      // prisma-ast keeps the quotes on a string literal.
      return assignment.value.replace(/^"|"$/g, "");
    }
  }
  return null;
}
