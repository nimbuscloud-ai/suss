/**
 * Which database a project connects to, from what it checks in, for the
 * packs whose library talks to several.
 *
 * A pack that reads its library's own connection settings, such as the
 * activerecord pack with Rails' database.yml, is asked first through its
 * `readFromProject`. This module covers what every stack shares: the
 * driver the project depends on, and the scheme of a `DATABASE_URL` in an
 * environment file. A project can declare more than one, such as SQLite
 * for development and Postgres in production, so every one found comes
 * back, in the order init trusts them, and init picks the first.
 */

import fs from "node:fs";
import path from "node:path";

import type { Ecosystem } from "@suss/ir-core";

type StorageSystem = "postgresql" | "mysql" | "sqlite";

export interface DeclaredDatabase {
  storageSystem: StorageSystem;
  /** Where the project declares it, as a phrase such as "pg in Gemfile.lock". */
  from: string;
}

export interface DeclaredLibraryName {
  ecosystem: Ecosystem;
  name: string;
  /** The manifest or field that listed it. */
  where: string;
}

/** The database behind each driver package, by the manifest that lists it. Python names are written the way `normalizePythonName` leaves them. */
const SYSTEM_OF_DRIVER: Record<Ecosystem, Record<string, StorageSystem>> = {
  rubygems: {
    pg: "postgresql",
    mysql2: "mysql",
    trilogy: "mysql",
    sqlite3: "sqlite",
  },
  pypi: {
    psycopg: "postgresql",
    "psycopg-binary": "postgresql",
    psycopg2: "postgresql",
    "psycopg2-binary": "postgresql",
    asyncpg: "postgresql",
    pg8000: "postgresql",
    pymysql: "mysql",
    mysqlclient: "mysql",
    aiomysql: "mysql",
    asyncmy: "mysql",
    "mysql-connector-python": "mysql",
    aiosqlite: "sqlite",
  },
  npm: {
    pg: "postgresql",
    postgres: "postgresql",
    mysql2: "mysql",
    mysql: "mysql",
    "better-sqlite3": "sqlite",
    sqlite3: "sqlite",
  },
};

/** The database behind each `DATABASE_URL` scheme, before any `+driver`. */
const SYSTEM_OF_SCHEME: Record<string, StorageSystem> = {
  postgres: "postgresql",
  postgresql: "postgresql",
  postgis: "postgresql",
  mysql: "mysql",
  mysql2: "mysql",
  mariadb: "mysql",
  trilogy: "mysql",
  sqlite: "sqlite",
  sqlite3: "sqlite",
};

/** The example files a project checks in for each developer to copy, then the one a developer keeps. */
const ENVIRONMENT_FILES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
  ".env",
];

const DATABASE_URL_LINE =
  /^\s*(?:export\s+)?DATABASE_URL\s*=\s*["']?([A-Za-z0-9+]+):/m;

/**
 * Every database the project declares, a `DATABASE_URL` first and then
 * the drivers in `libraries`. A driver a manifest lists for development
 * only comes after the others.
 */
export function databasesDeclaredIn(
  projectRoot: string,
  libraries: readonly DeclaredLibraryName[],
): DeclaredDatabase[] {
  return [
    ...databaseUrlsIn(projectRoot),
    ...[...libraries]
      .sort((a, b) => Number(isForDevelopment(a)) - Number(isForDevelopment(b)))
      .flatMap((library) => {
        const system = SYSTEM_OF_DRIVER[library.ecosystem][library.name];
        return system === undefined
          ? []
          : [
              {
                storageSystem: system,
                from: `${library.name} in ${library.where}`,
              },
            ];
      }),
  ];
}

function isForDevelopment(library: DeclaredLibraryName): boolean {
  return library.where.startsWith("devDependencies");
}

/**
 * The scheme of a `DATABASE_URL` in the project's environment files, and
 * in those of the folders above it up to the repository root, where a
 * monorepo keeps one file for every service.
 */
function databaseUrlsIn(projectRoot: string): DeclaredDatabase[] {
  return foldersUpToRepository(projectRoot).flatMap((folder) =>
    ENVIRONMENT_FILES.flatMap((name) => {
      const file = path.join(folder, name);
      const scheme = schemeIn(file);
      const system =
        scheme === null
          ? undefined
          : SYSTEM_OF_SCHEME[scheme.split("+")[0] ?? ""];
      return system === undefined
        ? []
        : [
            {
              storageSystem: system,
              from: `DATABASE_URL in ${path.relative(projectRoot, file)}`,
            },
          ];
    }),
  );
}

function schemeIn(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return DATABASE_URL_LINE.exec(text)?.[1]?.toLowerCase() ?? null;
}

/** The project folder, then each folder above it up to the one with `.git`. Only the project folder when it is in no repository. */
function foldersUpToRepository(projectRoot: string): string[] {
  const folders: string[] = [];
  let folder = path.resolve(projectRoot);
  for (;;) {
    folders.push(folder);
    if (fs.existsSync(path.join(folder, ".git"))) {
      return folders;
    }
    const parent = path.dirname(folder);
    if (parent === folder) {
      return [path.resolve(projectRoot)];
    }
    folder = parent;
  }
}
