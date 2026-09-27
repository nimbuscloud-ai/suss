import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { storageSystemFromDataSource } from "./dataSourceType.js";
import { declares } from "./index.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function projectOf(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-typeorm-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const FOR_ROOT = (options: string) => `
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

@Module({ imports: [TypeOrmModule.forRoot(${options})] })
export class AppModule {}
`;

describe("storageSystemFromDataSource", () => {
  it("reads the driver TypeOrmModule.forRoot is handed", () => {
    const root = projectOf({
      "src/app.module.ts": FOR_ROOT('{ type: "mysql", host: "db" }'),
    });
    expect(storageSystemFromDataSource(root)).toEqual({
      storageSystem: "mysql",
    });
  });

  it("reads the options a forRootAsync factory returns, and a DataSource", () => {
    const root = projectOf({
      "src/app.module.ts": `
        import { TypeOrmModule } from "@nestjs/typeorm";
        export const db = TypeOrmModule.forRootAsync({
          useFactory: () => ({ type: "postgres", url: process.env.DATABASE_URL }),
        });
      `,
      "src/dataSource.ts": `
        import { DataSource } from "typeorm";
        export default new DataSource({ type: "aurora-postgres" });
      `,
    });
    expect(storageSystemFromDataSource(root)).toEqual({
      storageSystem: "postgresql",
    });
  });

  it("does not say for a driver from the environment, one it cannot pair, or two kinds of database", () => {
    const fromEnv = projectOf({
      "src/app.module.ts": FOR_ROOT("{ type: process.env.DB_TYPE as never }"),
    });
    expect(storageSystemFromDataSource(fromEnv)).toBe(null);
    const unpaired = projectOf({
      "src/app.module.ts": FOR_ROOT('{ type: "mssql" }'),
    });
    expect(storageSystemFromDataSource(unpaired)).toBe(null);
    const two = projectOf({
      "src/app.module.ts": FOR_ROOT('{ type: "sqlite" }'),
      "src/reports.module.ts": FOR_ROOT('{ type: "postgres" }'),
    });
    expect(storageSystemFromDataSource(two)).toBe(null);
    expect(storageSystemFromDataSource(path.join(two, "missing"))).toBe(null);
  });

  it("skips installed packages and files that do not use TypeORM", () => {
    const root = projectOf({
      "node_modules/other/index.js": FOR_ROOT('{ type: "mysql" }'),
      "src/other.ts": 'export const shape = { type: "mysql" };',
      "src/app.module.ts": FOR_ROOT('{ type: "better-sqlite3" }'),
    });
    expect(storageSystemFromDataSource(root)).toEqual({
      storageSystem: "sqlite",
    });
  });

  it("is what suss init reads the pack's config from", () => {
    expect(declares.configuration?.readFromProject).toBe(
      storageSystemFromDataSource,
    );
  });
});
