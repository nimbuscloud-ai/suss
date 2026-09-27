/**
 * Reads which database a Rails app connects to from the `adapter` lines
 * in `config/database.yml`, the file ActiveRecord takes its connections
 * from. `suss init` calls this to fill in `storageSystem` for the pack.
 *
 * The file is YAML with ERB in it, and Rails runs the ERB before it
 * parses the YAML. Only the `adapter` lines matter here, so they are read
 * one at a time. An adapter written as ERB, or one this pack has no
 * storage system for, means the file does not say.
 */

import fs from "node:fs";
import path from "node:path";

/** The storage system behind each adapter Rails ships a connection for. */
const STORAGE_SYSTEM_OF_ADAPTER: Record<string, string> = {
  postgresql: "postgresql",
  mysql2: "mysql",
  trilogy: "mysql",
  sqlite3: "sqlite",
};

/**
 * `{ storageSystem }` for the one kind of database the file connects to,
 * or null when there is no file, no adapter line, an adapter this cannot
 * read, or adapters for more than one kind of database.
 */
export function storageSystemFromDatabaseYml(
  projectRoot: string,
): { storageSystem: string } | null {
  const file = path.join(projectRoot, "config", "database.yml");
  if (!fs.existsSync(file)) {
    return null;
  }

  const systems = new Set<string>();
  for (const match of fs
    .readFileSync(file, "utf8")
    .matchAll(/^\s*adapter:\s*(.*)$/gm)) {
    const system = STORAGE_SYSTEM_OF_ADAPTER[adapterName(match[1] ?? "")];
    if (system === undefined) {
      return null;
    }
    systems.add(system);
  }

  const [only] = systems;
  return systems.size === 1 && only !== undefined
    ? { storageSystem: only }
    : null;
}

/** The value after `adapter:`, without a trailing comment or quotes. */
function adapterName(written: string): string {
  const value = written.replace(/\s+#.*$/, "").trim();
  return /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
}
