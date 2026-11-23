import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { storageSystemFromDatabaseYml } from "./databaseYml.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-database-yml-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function databaseYml(contents: string, name = "database.yml"): void {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", name), contents);
}

function systemOf(): unknown {
  return storageSystemFromDatabaseYml(root)?.values.storageSystem ?? null;
}

describe("the database a Rails app connects to, from config/database.yml", () => {
  it("reads the adapter the default block gives every environment", () => {
    databaseYml(
      [
        "default: &default",
        "  adapter: postgresql",
        "  encoding: unicode",
        '  pool: <%= ENV.fetch("RAILS_MAX_THREADS") { 5 } %>',
        "",
        "development:",
        "  <<: *default",
        "  database: orders_development",
        "",
      ].join("\n"),
    );

    expect(storageSystemFromDatabaseYml(root)).toEqual({
      values: { storageSystem: "postgresql" },
      from: "the development adapter in config/database.yml",
    });
  });

  it("spells each adapter Rails ships as the storage system it connects to", () => {
    for (const [adapter, system] of [
      ["mysql2", "mysql"],
      ["trilogy", "mysql"],
      ['"sqlite3"', "sqlite"],
      ["postgresql # the primary database", "postgresql"],
    ]) {
      databaseYml(`production:\n  adapter: ${adapter}\n`);
      expect(systemOf(), adapter).toBe(system);
    }
  });

  it("takes the development database when environments use different kinds", () => {
    databaseYml(
      "development:\n  adapter: sqlite3\nproduction:\n  adapter: postgresql\n",
    );

    expect(storageSystemFromDatabaseYml(root)).toEqual({
      values: { storageSystem: "sqlite" },
      from: "the development adapter in config/database.yml",
    });
  });

  it("reads each database of a multi-database environment through its anchor", () => {
    databaseYml(
      [
        "local: &local",
        "  adapter: sqlite3",
        "development:",
        "  primary:",
        "    <<: *local",
        "    database: db/primary.sqlite3",
        "  jobs:",
        "    <<: *local",
        "    database: db/jobs.sqlite3",
        "production:",
        "  primary:",
        "    adapter: postgresql",
      ].join("\n"),
    );

    expect(systemOf()).toBe("sqlite");
  });

  it("reads the sample a project checks in when database.yml is not there", () => {
    databaseYml("development:\n  adapter: mysql2\n", "database.yml.sample");

    expect(storageSystemFromDatabaseYml(root)).toEqual({
      values: { storageSystem: "mysql" },
      from: "the development adapter in config/database.yml.sample",
    });
  });

  it("does not say when the adapter comes from the environment", () => {
    databaseYml('production:\n  adapter: <%= ENV["DB_ADAPTER"] %>\n');

    expect(storageSystemFromDatabaseYml(root)).toBeNull();
  });

  it("does not say when environments other than development disagree", () => {
    databaseYml("test:\n  adapter: sqlite3\nproduction:\n  adapter: mysql2\n");

    expect(storageSystemFromDatabaseYml(root)).toBeNull();
  });

  it("reads the adapter lines of a file whose YAML does not parse", () => {
    databaseYml("production:\n  adapter: postgresql\n  pool: [\n");

    expect(systemOf()).toBe("postgresql");
  });

  it("does not say when there is no file, or the file has no adapter", () => {
    expect(storageSystemFromDatabaseYml(root)).toBeNull();

    databaseYml('production:\n  url: <%= ENV["DATABASE_URL"] %>\n');
    expect(storageSystemFromDatabaseYml(root)).toBeNull();
  });
});
