/**
 * Reads which database a Rails app connects to from the `adapter` lines
 * in `config/database.yml`, the file ActiveRecord takes its connections
 * from. `suss init` calls this to fill in `storageSystem` for the pack.
 *
 * Many apps keep that file out of the repository and check in a copy
 * such as `database.yml.sample`, which is read when the file is missing.
 *
 * The file is YAML with ERB in it, and Rails runs the ERB before it
 * parses the YAML. The ERB is dropped here, so an adapter written as ERB
 * reads as missing. When environments use different databases, the one
 * Rails runs by default, development, decides. An adapter this pack has
 * no storage system for means the file does not say.
 */

import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import type { ProjectValues } from "@suss/ir-core";

/** The storage system behind each adapter Rails ships a connection for. */
const STORAGE_SYSTEM_OF_ADAPTER: Record<string, string> = {
  postgresql: "postgresql",
  postgis: "postgresql",
  mysql2: "mysql",
  trilogy: "mysql",
  sqlite3: "sqlite",
};

/** The file Rails reads, then the copies apps check in instead of it. */
const DATABASE_FILES = [
  "database.yml",
  "database.yml.sample",
  "database.yml.example",
  "database.yml.dist",
];

/** The environment Rails runs in when nothing sets RAILS_ENV. */
const DEFAULT_ENVIRONMENT = "development";

/**
 * `{ storageSystem }` for the one kind of database the file connects to,
 * or null when there is no file, no adapter, an adapter this cannot read,
 * or adapters for more than one kind of database and none for
 * development.
 */
export function storageSystemFromDatabaseYml(
  projectRoot: string,
): ProjectValues | null {
  const name = DATABASE_FILES.find((candidate) =>
    fs.existsSync(path.join(projectRoot, "config", candidate)),
  );
  if (name === undefined) {
    return null;
  }

  const shown = `config/${name}`;
  const text = fs.readFileSync(path.join(projectRoot, "config", name), "utf8");
  const byEnvironment = adaptersByEnvironment(text);
  const development = byEnvironment?.get(DEFAULT_ENVIRONMENT);
  if (development !== undefined && development.length > 0) {
    return onlySystem(
      development,
      `the ${DEFAULT_ENVIRONMENT} adapter in ${shown}`,
    );
  }

  const every =
    byEnvironment === null
      ? adapterLines(text)
      : [...byEnvironment.values()].flat();
  return onlySystem(every, `the adapter in ${shown}`);
}

function onlySystem(
  adapters: readonly string[],
  from: string,
): ProjectValues | null {
  const systems = new Set<string>();
  for (const adapter of adapters) {
    const system = STORAGE_SYSTEM_OF_ADAPTER[adapter];
    if (system === undefined) {
      return null;
    }
    systems.add(system);
  }

  const [only] = systems;
  return systems.size === 1 && only !== undefined
    ? { values: { storageSystem: only }, from }
    : null;
}

/**
 * The adapters each top-level key gives, with `<<: *default` merged in
 * and a multi-database environment's databases each counted. Null when
 * the file does not parse once its ERB is gone.
 */
function adaptersByEnvironment(text: string): Map<string, string[]> | null {
  let parsed: unknown;
  try {
    parsed = parse(text.replace(/<%[\s\S]*?%>/g, ""), { merge: true });
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const byEnvironment = new Map<string, string[]>();
  for (const [environment, settings] of Object.entries(parsed)) {
    byEnvironment.set(environment, adaptersOf(settings));
  }
  return byEnvironment;
}

/** An empty adapter, such as one written as ERB, counts as one this cannot read. */
function adaptersOf(settings: unknown): string[] {
  if (!isRecord(settings)) {
    return [];
  }

  if ("adapter" in settings) {
    return [adapterValue(settings.adapter)];
  }
  return Object.values(settings).flatMap((database) =>
    isRecord(database) && "adapter" in database
      ? [adapterValue(database.adapter)]
      : [],
  );
}

function adapterValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Every `adapter:` line, for a file whose YAML does not parse. */
function adapterLines(text: string): string[] {
  return [...text.matchAll(/^\s*adapter:\s*(.*)$/gm)].map((match) =>
    adapterName(match[1] ?? ""),
  );
}

/** The value after `adapter:`, without a trailing comment or quotes. */
function adapterName(written: string): string {
  const value = written.replace(/\s+#.*$/, "").trim();
  return /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
