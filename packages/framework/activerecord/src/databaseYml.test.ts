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

function databaseYml(contents: string): void {
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "database.yml"), contents);
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
      storageSystem: "postgresql",
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
      expect(storageSystemFromDatabaseYml(root), adapter).toEqual({
        storageSystem: system,
      });
    }
  });

  it("does not say when environments use different kinds of database", () => {
    databaseYml(
      "development:\n  adapter: sqlite3\nproduction:\n  adapter: postgresql\n",
    );

    expect(storageSystemFromDatabaseYml(root)).toBeNull();
  });

  it("does not say when the adapter comes from the environment", () => {
    databaseYml('production:\n  adapter: <%= ENV["DB_ADAPTER"] %>\n');

    expect(storageSystemFromDatabaseYml(root)).toBeNull();
  });

  it("does not say when there is no file, or the file has no adapter", () => {
    expect(storageSystemFromDatabaseYml(root)).toBeNull();

    databaseYml('production:\n  url: <%= ENV["DATABASE_URL"] %>\n');
    expect(storageSystemFromDatabaseYml(root)).toBeNull();
  });
});
