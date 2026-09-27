/**
 * Reads which database a project's TypeORM connection uses from the
 * `type` in the options it hands `TypeOrmModule.forRoot(...)`,
 * `TypeOrmModule.forRootAsync(...)` or `new DataSource(...)`. `suss init`
 * calls this to fill in `storageSystem` for the pack.
 *
 * Only a `type` written as a string counts, anywhere inside those
 * options, so the object a `forRootAsync` factory returns is read too. A
 * type read from the environment, a driver this pack has no storage
 * system for, or drivers for more than one kind of database mean the
 * project does not say.
 */

import fs from "node:fs";
import path from "node:path";

import { ts } from "ts-morph";

/** The storage system behind each TypeORM driver the pack can pair. */
const STORAGE_SYSTEM_OF_DRIVER: Record<string, string> = {
  postgres: "postgresql",
  "aurora-postgres": "postgresql",
  mysql: "mysql",
  mariadb: "mysql",
  "aurora-mysql": "mysql",
  sqlite: "sqlite",
  "better-sqlite3": "sqlite",
  sqljs: "sqlite",
};

/** Drivers TypeORM ships that the pack has no storage system for. */
const UNPAIRED_DRIVERS = new Set([
  "cockroachdb",
  "mssql",
  "oracle",
  "sap",
  "spanner",
  "mongodb",
]);

const CONNECTION_FACTORIES = new Set(["forRoot", "forRootAsync"]);

const INSTALLED_PACKAGES = "node_modules";

const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js)$/;

/**
 * `{ storageSystem }` for the one kind of database the project's TypeORM
 * connections use, or null when the project does not say.
 */
export function storageSystemFromDataSource(
  projectRoot: string,
): { storageSystem: string } | null {
  const systems = new Set<string>();
  for (const file of sourceFilesUnder(projectRoot)) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("typeorm")) {
      continue;
    }
    for (const driver of driversIn(file, text)) {
      if (UNPAIRED_DRIVERS.has(driver)) {
        return null;
      }
      const system = STORAGE_SYSTEM_OF_DRIVER[driver];
      if (system !== undefined) {
        systems.add(system);
      }
    }
  }
  const [only] = systems;
  return systems.size === 1 && only !== undefined
    ? { storageSystem: only }
    : null;
}

function sourceFilesUnder(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && entry.name !== INSTALLED_PACKAGES) {
        files.push(...sourceFilesUnder(full));
      }
      continue;
    }
    if (
      entry.isFile() &&
      SOURCE_FILE.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

/** Every string `type` inside the options of a connection the file makes. */
function driversIn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const options = connectionOptionsOf(node);
    if (options !== undefined) {
      found.push(...stringTypesIn(options, source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function connectionOptionsOf(node: ts.Node): ts.Expression | undefined {
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "DataSource"
  ) {
    return node.arguments?.[0];
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    CONNECTION_FACTORIES.has(node.expression.name.text) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "TypeOrmModule"
  ) {
    return node.arguments[0];
  }
  return undefined;
}

function stringTypesIn(options: ts.Node, source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "type" &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      found.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(options);
  return found;
}
