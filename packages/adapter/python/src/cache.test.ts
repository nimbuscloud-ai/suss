/**
 * The on-disk extraction cache, exercised against a temp directory.
 *
 * Running under vitest gives the adapter a "source" code stamp, and a
 * run from source always declines to cache. `./version.js` is mocked
 * here so `adapterStamp.declineWhenRunFromSource` passes `cacheDir`
 * through unchanged. That is what puts the cache layer itself under
 * test, the same one a built CLI run reaches.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./version.js")>();
  return {
    ...actual,
    adapterStamp: {
      ...actual.adapterStamp,
      declineWhenRunFromSource: (cacheDir: string | null) => cacheDir,
    },
  };
});

import { extractPythonProject, findPythonFiles } from "./project.js";

import type { CacheDiagnostic } from "@suss/extractor";
import type { PythonPack } from "./pack.js";

const flaskRestxLike: PythonPack = {
  name: "flask-restx",
  protocol: "http",
  discovery: [
    {
      type: "decoratedClassRoute",
      importModule: ["myapp.wrappers.restx"],
      decoratorName: "route",
      verbMethodNames: { get: "GET", post: "POST" },
    },
  ],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-python-cache-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function routeProject(): string[] {
  write(
    "myapp/wrappers/restx.py",
    "from flask_restx import Namespace\n\napi = Namespace('app')\n\n\ndef route(path):\n    return api.route(path)\n",
  );
  write(
    "myapp/routes/todos.py",
    'from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return []\n',
  );
  return findPythonFiles(tmpDir);
}

function testPacks(): PythonPack[] {
  return [{ ...flaskRestxLike, projectModules: ["myapp.wrappers.restx"] }];
}

describe("extractPythonProject's on-disk cache", () => {
  it("misses the first run and hits the second over unchanged files", async () => {
    const files = routeProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    const first = await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    const second = await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(first.summaries.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.kind).toBe("miss");
    expect(diagnostics[1]).toEqual({ kind: "hit" });
    expect(second.summaries).toEqual(first.summaries);
  });

  it("re-extracts the one file whose content changed and replays the rest", async () => {
    const files = routeProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    write(
      "myapp/routes/todos.py",
      'from myapp.wrappers.restx import route\n\n\n@route("/todos")\nclass TodoList:\n    def get(self):\n        return [1]\n',
    );
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]?.kind).toBe("partial");
    expect(diagnostics[1]?.partial).toMatchObject({
      filesChanged: 1,
      rootsReused: 1,
      rootsReextracted: 1,
    });
  });

  describe("a run that replays part of the entry", () => {
    const fastapiLike: PythonPack = {
      name: "fastapi-test",
      protocol: "http",
      discovery: [
        {
          type: "decoratedFunctionRoute",
          importModule: ["fastapi"],
          verbAttributeNames: { get: "GET", post: "POST" },
          pathParamSyntax: "braces",
          injectedParameterCallees: ["Depends"],
          defaultStatusCode: 200,
          routerComposition: {
            routerConstructorName: "APIRouter",
            includeMethodName: "include_router",
            routerKeyword: "router",
            prefixKeyword: "prefix",
          },
          wrappers: [
            {
              type: "dependency",
              callees: ["Depends"],
              keyword: "dependencies",
              registrars: [
                { constructorName: "FastAPI", covers: "everyRoute" },
                { constructorName: "APIRouter", covers: "ownRoutes" },
              ],
            },
          ],
        } as PythonPack["discovery"][number],
      ],
    };

    const MAIN = [
      "from fastapi import FastAPI, Depends",
      "from app.routes import items, orders",
      "from app.deps import audit",
      "",
      "app = FastAPI(dependencies=[Depends(audit)])",
      'app.include_router(items.router, prefix="/api")',
      'app.include_router(orders.router, prefix="/api")',
      "",
    ].join("\n");

    const DEPS = [
      "def audit():",
      "    return None",
      "",
      "",
      "def current_user():",
      "    return lookup_user()",
      "",
      "",
      "def lookup_user():",
      '    return {"id": 1}',
      "",
    ].join("\n");

    const ITEMS = [
      "from fastapi import APIRouter, Depends",
      "from app.deps import current_user",
      "",
      'router = APIRouter(prefix="/items")',
      "",
      "",
      '@router.get("/")',
      "def list_items(user=Depends(current_user)):",
      "    return fetch_items(user)",
      "",
      "",
      "def fetch_items(user):",
      "    return []",
      "",
    ].join("\n");

    const ORDERS = [
      "from fastapi import APIRouter",
      "from app.helpers import *",
      "",
      'router = APIRouter(prefix="/orders")',
      "",
      "",
      '@router.get("/")',
      "def list_orders():",
      "    return summarize()",
      "",
    ].join("\n");

    function shopProject(): string[] {
      write("app/__init__.py", "");
      write("app/routes/__init__.py", "");
      write("app/main.py", MAIN);
      write("app/deps.py", DEPS);
      write("app/routes/items.py", ITEMS);
      write("app/routes/orders.py", ORDERS);
      write("app/helpers.py", "def unrelated():\n    return 1\n");
      return findPythonFiles(tmpDir);
    }

    /** A cached run and a run without the cache over the same files, each as the JSON the CLI would write. */
    async function bothRuns(
      files: string[],
      diagnostics: CacheDiagnostic[],
    ): Promise<{ cached: string; cold: string }> {
      const options = {
        files,
        roots: [tmpDir],
        packs: [fastapiLike],
        projectRoot: tmpDir,
      };
      const cached = await extractPythonProject({
        ...options,
        onCacheDiagnostic: (d) => diagnostics.push(d),
      });
      const cold = await extractPythonProject({ ...options, cacheDir: null });
      return {
        cached: JSON.stringify(cached.summaries),
        cold: JSON.stringify(cold.summaries),
      };
    }

    it("gives what a run without the cache gives after a branch is added inside a route", async () => {
      const files = shopProject();
      const diagnostics: CacheDiagnostic[] = [];
      await bothRuns(files, diagnostics);
      write(
        "app/routes/items.py",
        ITEMS.replace(
          "    return fetch_items(user)",
          "    if user is None:\n        return []\n    return fetch_items(user)",
        ),
      );

      const { cached, cold } = await bothRuns(files, diagnostics);

      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
      expect(diagnostics[1]?.partial?.rootsReextracted).toBe(1);
    });

    it("gives what a run without the cache gives after the mount prefix changes in another file", async () => {
      const files = shopProject();
      const diagnostics: CacheDiagnostic[] = [];
      const before = await bothRuns(files, diagnostics);
      write("app/main.py", MAIN.replaceAll('prefix="/api"', 'prefix="/v2"'));

      const { cached, cold } = await bothRuns(files, diagnostics);

      expect(cold).not.toBe(before.cold);
      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
    });

    it("gives what a run without the cache gives after a dependency's body changes", async () => {
      const files = shopProject();
      const diagnostics: CacheDiagnostic[] = [];
      await bothRuns(files, diagnostics);
      write(
        "app/deps.py",
        DEPS.replace(
          "    return lookup_user()",
          "    user = lookup_user()\n    if user is None:\n        return None\n    return user",
        ),
      );

      const { cached, cold } = await bothRuns(files, diagnostics);

      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
    });

    it("gives what a run without the cache gives after a wildcard import starts bringing in a called name", async () => {
      const files = shopProject();
      const diagnostics: CacheDiagnostic[] = [];
      const before = await bothRuns(files, diagnostics);
      write(
        "app/helpers.py",
        "def unrelated():\n    return 1\n\n\ndef summarize():\n    return unrelated()\n",
      );

      const { cached, cold } = await bothRuns(files, diagnostics);

      expect(cold).not.toBe(before.cold);
      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
    });

    const withStorage: PythonPack = {
      ...fastapiLike,
      discovery: [
        {
          ...(fastapiLike.discovery[0] as PythonPack["discovery"][number]),
          annotatedClassIsRequestBody: true,
        } as PythonPack["discovery"][number],
      ],
      storage: [
        {
          module: "sqlalchemy",
          queryTypes: ["Select"],
          writes: ["update", "delete"],
          queryFunctions: ["select"],
          storageSystem: "postgresql",
        },
      ],
    };

    const CONFIG = "import os\n\n\ndef env(key):\n    return os.environ[key]\n";
    const MODELS = [
      "from pydantic import BaseModel",
      "",
      "",
      "class ItemIn(BaseModel):",
      "    name: str",
      "",
    ].join("\n");
    const WRITES = [
      "from fastapi import APIRouter",
      "from sqlalchemy import select",
      "from app.config import env",
      "from app.models import ItemIn",
      "",
      'router = APIRouter(prefix="/writes")',
      "",
      "",
      '@router.post("/items")',
      "def create_item(item: ItemIn):",
      '    env("PAGE_SIZE")',
      "    return select(Items.id).all()",
      "",
      "",
      '@router.post("/copies")',
      "def copy_item(item: ItemIn):",
      "    return load_items()",
      "",
      "",
      "def load_items():",
      "    return select(Items.id).all()",
      "",
    ].join("\n");

    /** The shop, plus a file whose routes read a model, the environment and the database. */
    function storedShop(): string[] {
      shopProject();
      write("app/config.py", CONFIG);
      write("app/models.py", MODELS);
      write("app/routes/writes.py", WRITES);
      write(
        "app/main.py",
        `${MAIN}app.include_router(writes.router)\n`.replace(
          "from app.routes import items, orders",
          "from app.routes import items, orders, writes",
        ),
      );
      return findPythonFiles(tmpDir);
    }

    /** `bothRuns`, with the storage pack in place of the plain one. */
    async function bothStorageRuns(
      files: string[],
      diagnostics: CacheDiagnostic[],
    ): Promise<{ cached: string; cold: string }> {
      const options = {
        files,
        roots: [tmpDir],
        packs: [withStorage],
        projectRoot: tmpDir,
      };
      const cached = await extractPythonProject({
        ...options,
        onCacheDiagnostic: (d) => diagnostics.push(d),
      });
      const cold = await extractPythonProject({ ...options, cacheDir: null });
      return {
        cached: JSON.stringify(cached.summaries),
        cold: JSON.stringify(cold.summaries),
      };
    }

    it.each([
      [
        "the helper a route reads the environment through",
        "app/config.py",
        CONFIG.replace("os.environ[key]", 'os.environ.get(key, "10")'),
      ],
      [
        "the model a route's body is read from",
        "app/models.py",
        `${MODELS}    price: int\n`,
      ],
    ])(
      "gives what a run without the cache gives after %s changes",
      async (_what, file, content) => {
        const files = storedShop();
        const diagnostics: CacheDiagnostic[] = [];
        await bothStorageRuns(files, diagnostics);
        write("app/helpers.py", "def unrelated():\n    return 2\n");
        const unrelated = await bothStorageRuns(files, diagnostics);
        write(file, content);

        const { cached, cold } = await bothStorageRuns(files, diagnostics);

        expect(unrelated.cached).toBe(unrelated.cold);
        expect(diagnostics[1]?.kind).toBe("partial");
        expect(cold).not.toBe(unrelated.cold);
        expect(cached).toBe(cold);
      },
    );

    /** The entry the runs so far wrote, to change by hand. */
    function manifestPath(): string {
      const cacheDir = path.join(tmpDir, ".suss", "cache");
      const entry = fs
        .readdirSync(cacheDir)
        .find((name) => name.startsWith("key-")) as string;
      return path.join(cacheDir, entry, "manifest.json");
    }

    it.each([
      ["a function the walk followed", "walked"],
      ["a wrapper a route registered", "registration"],
    ])(
      "starts over when %s is no longer where the entry says",
      async (_what, part) => {
        const files = shopProject();
        const diagnostics: CacheDiagnostic[] = [];
        await bothRuns(files, diagnostics);
        const file = manifestPath();
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const meta of manifest.rootMeta) {
          for (const walk of part === "walked" ? meta.meta.walked : []) {
            for (const target of walk.scan.followed) {
              target.key = `${target.key}9`;
            }
          }
          for (const registration of part === "registration"
            ? meta.meta.registrations
            : []) {
            registration.key = `${registration.key}9`;
          }
        }
        fs.writeFileSync(file, JSON.stringify(manifest));
        write("app/helpers.py", "def unrelated():\n    return 2\n");

        const { cached, cold } = await bothRuns(files, diagnostics);

        expect(cached).toBe(cold);
        expect(diagnostics[1]).toEqual({
          kind: "miss",
          missReason: "files-changed",
        });
      },
    );

    it("hits after a file is written again with the same content", async () => {
      const files = shopProject();
      const diagnostics: CacheDiagnostic[] = [];
      await bothRuns(files, diagnostics);
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(tmpDir, "app", "deps.py"), later, later);

      const { cached, cold } = await bothRuns(files, diagnostics);

      expect(cached).toBe(cold);
      expect(diagnostics[1]).toEqual({ kind: "hit" });
    });
  });

  it("misses with key-changed once a pack's declared version changes", async () => {
    const files = routeProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs: [{ ...packs[0], version: "2" }],
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  it("misses with key-changed once the gap setting changes", async () => {
    const files = routeProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      gapHandling: "silent",
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  it("misses with key-changed once the directory ids are measured from changes", async () => {
    const files = routeProject();
    const packs = testPacks();
    const cacheDir = path.join(tmpDir, ".suss", "cache");
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      cacheDir,
      onCacheDiagnostic,
    });
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: path.join(tmpDir, "myapp"),
      cacheDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  it("never writes an entry when cacheDir is null", async () => {
    const files = routeProject();
    const packs = testPacks();

    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      cacheDir: null,
    });
    await extractPythonProject({
      files,
      roots: [tmpDir],
      packs,
      projectRoot: tmpDir,
      cacheDir: null,
    });

    expect(fs.existsSync(path.join(tmpDir, ".suss", "cache"))).toBe(false);
  });
});
