import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { preloadPythonGrammar } from "../parser.js";
import { PythonWhySession } from "./why.js";

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

  it("returns null for a name with no expression on that line", () => {
    fs.writeFileSync(path.join(dir, "app.py"), "x = 1\n");
    const session = new PythonWhySession({ dir });
    expect(session.findExpression("app.py", 1, "nope")).toBeNull();
  });
});
