import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { preloadPythonGrammar } from "../parser.js";
import { PythonWhySession } from "./why.js";

import type { PythonPack } from "../pack.js";

describe("PythonWhySession", () => {
  let dir: string;

  beforeAll(async () => {
    await preloadPythonGrammar();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-py-why-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("follows a name through a wrapper module to the function it is imported from", () => {
    fs.writeFileSync(
      path.join(dir, "helpers.py"),
      "def fetch():\n    return 1\n",
    );
    fs.writeFileSync(
      path.join(dir, "wrappers.py"),
      "from helpers import fetch as get\n",
    );
    fs.writeFileSync(
      path.join(dir, "app.py"),
      "from wrappers import get\n\nx = get()\n",
    );

    const session = new PythonWhySession({ dir });
    const value = session.findExpression("app.py", 3, "get");
    expect(value).not.toBeNull();
    const explained = value === null ? null : session.explain(value);

    expect(explained).not.toBeNull();
    expect(explained?.target).toEqual({
      name: "fetch",
      file: "helpers.py",
      line: 1,
    });
    expect(explained?.chain).toEqual([
      "get (app.py:1)",
      "get (wrappers.py:1)",
      "fetch (helpers.py:1)",
    ]);
    expect(explained?.explanation.steps.map((step) => step.rule)).toEqual([
      "import",
      "import",
    ]);
  });

  it("resolves an import of a package kept under src without being told the roots", () => {
    const pkg = path.join(dir, "src", "shop");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "__init__.py"), "");
    fs.writeFileSync(
      path.join(pkg, "helpers.py"),
      "def fetch():\n    return 1\n",
    );
    fs.writeFileSync(
      path.join(pkg, "app.py"),
      "from shop.helpers import fetch\n\nx = fetch()\n",
    );

    const session = new PythonWhySession({ dir });
    const value = session.findExpression("src/shop/app.py", 3, "fetch");
    const explained = value === null ? null : session.explain(value);

    expect(explained?.target).toEqual({
      name: "fetch",
      file: "src/shop/helpers.py",
      line: 1,
    });
  });

  it("finds the callee a summary recorded, in the caller's own lines", () => {
    fs.writeFileSync(
      path.join(dir, "helpers.py"),
      "def fetch():\n    return 1\n",
    );
    fs.writeFileSync(
      path.join(dir, "app.py"),
      "from helpers import fetch\n\ndef handler():\n    return fetch()\n",
    );

    const session = new PythonWhySession({ dir });
    const callee = session.findCallee("app.py", 3, 4, "fetch");
    expect(callee).not.toBeNull();
    const explained = callee === null ? null : session.explain(callee);
    expect(explained?.target.name).toBe("fetch");
    expect(explained?.target.file).toBe("helpers.py");
  });

  // Each copy is one more place a class is made, and the rules that
  // follow a value under the place it was made join every such place
  // against every value, so the copies make that cost visible.
  it("derives only what the proof can use when many classes are made", () => {
    const module = (suffix: string): string =>
      [
        `class Report${suffix}:`,
        "    def publish(self):",
        "        return True",
        "",
        `def show${suffix}():`,
        `    report = Report${suffix}(title="draft")`,
        "    report.publish()",
        "",
      ].join("\n");
    fs.writeFileSync(path.join(dir, "reports.py"), module(""));
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(dir, `reports${i}.py`), module(String(i)));
    }

    const session = new PythonWhySession({ dir });
    const value = session.findExpression("reports.py", 7, "report.publish");
    const explained = value === null ? null : session.explain(value);

    expect(explained?.target).toEqual({
      name: "publish",
      file: "reports.py",
      line: 2,
    });
    const stats = explained?.stats;
    expect(stats).toBeDefined();
    expect(stats?.derivedFacts).toBeLessThan(3 * (stats?.baseFacts ?? 0));
  }, 20_000);

  describe("a method called on what a pack's model method gave back", () => {
    const sqlModelLike: PythonPack = {
      name: "sqlmodel",
      protocol: "postgresql",
      discovery: [],
      models: [
        {
          baseNames: ["SQLModel"],
          givesBack: [],
          entryMethods: [{ method: "get", argument: 0 }],
          entryFunctions: [],
        },
      ],
    };

    const explainClose = (packs: readonly PythonPack[]) => {
      fs.writeFileSync(
        path.join(dir, "models.py"),
        "from sqlmodel import SQLModel\n\nclass Account(SQLModel):\n    def close(self):\n        return True\n",
      );
      fs.writeFileSync(
        path.join(dir, "app.py"),
        "from models import Account\n\ndef run(session):\n    account = session.get(Account, 1)\n    return account.close()\n",
      );
      const session = new PythonWhySession({ dir, packs });
      const value = session.findExpression("app.py", 5, "account.close");
      return value === null ? null : session.explain(value);
    };

    it("follows it to the model's method when the session has the pack", () => {
      expect(explainClose([sqlModelLike])?.target).toEqual({
        name: "close",
        file: "models.py",
        line: 4,
      });
    });

    it("cannot follow it without the pack, which is the only thing that says what get gives back", () => {
      expect(explainClose([])).toBeNull();
    });
  });

  it("returns null for a name with no expression on that line", () => {
    fs.writeFileSync(path.join(dir, "app.py"), "x = 1\n");
    const session = new PythonWhySession({ dir });
    expect(session.findExpression("app.py", 1, "nope")).toBeNull();
  });

  it("returns null for a file the project does not contain", () => {
    fs.writeFileSync(path.join(dir, "app.py"), "x = 1\n");
    const session = new PythonWhySession({ dir });
    expect(session.findExpression("missing.py", 1, "x")).toBeNull();
    expect(session.findCallee("missing.py", 1, 1, "x")).toBeNull();
  });

  it("picks the innermost of two nodes with the same text on a line", () => {
    fs.writeFileSync(
      path.join(dir, "helpers.py"),
      "def fetch():\n    return 1\n",
    );
    fs.writeFileSync(
      path.join(dir, "app.py"),
      "from helpers import fetch\n\nfetch\n",
    );

    const session = new PythonWhySession({ dir });
    const value = session.findExpression("app.py", 3, "fetch");
    expect(value?.node.type).toBe("identifier");
    const explained = value === null ? null : session.explain(value);
    expect(explained?.target.file).toBe("helpers.py");
  });

  it("describes a local and a parameter written inside a function by name and line", () => {
    fs.writeFileSync(
      path.join(dir, "app.py"),
      [
        "class Closer:",
        "    def close(self):",
        "        return 1",
        "",
        "",
        "def close_with(closer: Closer, retries=1, *rest, **options):",
        "    again = closer",
        "    again.close()",
        "    return closer.close()",
        "",
        "",
        "close_with(Closer())",
        "",
      ].join("\n"),
    );

    const session = new PythonWhySession({ dir });
    const explain = (line: number, text: string) => {
      const value = session.findExpression("app.py", line, text);
      return value === null ? null : session.explain(value);
    };
    expect(explain(8, "again.close")?.chain).toEqual([
      "again.close (app.py:8)",
      "close (app.py:2)",
    ]);
    expect(explain(8, "again.close")?.lines.join("\n")).toContain(
      "again (app.py:7)",
    );
    expect(explain(9, "closer.close")?.lines.join("\n")).toContain(
      "closer (app.py:6)",
    );
  });
});
