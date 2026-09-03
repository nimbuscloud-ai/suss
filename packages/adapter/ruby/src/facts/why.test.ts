import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { preloadRubyGrammar } from "../parser.js";
import { RubyWhySession } from "./why.js";

describe("RubyWhySession", () => {
  let dir: string;

  beforeAll(async () => {
    await preloadRubyGrammar();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-rb-why-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("follows a bare class method read to its definition", () => {
    fs.writeFileSync(
      path.join(dir, "helpers.rb"),
      "class Helpers\n  def self.fetch\n    1\n  end\nend\n",
    );
    fs.writeFileSync(path.join(dir, "app.rb"), "x = Helpers.fetch\n");

    const session = new RubyWhySession({ dir });
    const value = session.findExpression("app.rb", 1, "fetch");
    expect(value).not.toBeNull();
    const explained = value === null ? null : session.explain(value);

    expect(explained).not.toBeNull();
    expect(explained?.target).toEqual({
      name: "fetch",
      file: "helpers.rb",
      line: 2,
    });
    expect(explained?.explanation.steps.map((step) => step.rule)).toEqual([
      "property read",
    ]);
  });

  it("finds the callee a summary recorded, in the caller's own lines", () => {
    fs.writeFileSync(
      path.join(dir, "helpers.rb"),
      "class Helpers\n  def self.fetch(x)\n    x\n  end\nend\n",
    );
    fs.writeFileSync(
      path.join(dir, "app.rb"),
      "class App\n  def call\n    Helpers.fetch(1)\n  end\nend\n",
    );

    const session = new RubyWhySession({ dir });
    const callee = session.findCallee("app.rb", 2, 4, "fetch");
    expect(callee).not.toBeNull();
    const explained = callee === null ? null : session.explain(callee);
    expect(explained?.target.name).toBe("fetch");
    expect(explained?.target.file).toBe("helpers.rb");
  });

  it("follows an instance method read through the object it was called on", () => {
    fs.writeFileSync(
      path.join(dir, "helpers.rb"),
      "class Helpers\n  def fetch\n    1\n  end\nend\n",
    );
    fs.writeFileSync(
      path.join(dir, "app.rb"),
      "h = Helpers.new\nx = h.fetch\n",
    );

    const session = new RubyWhySession({ dir });
    const value = session.findExpression("app.rb", 2, "fetch");
    const explained = value === null ? null : session.explain(value);

    expect(explained?.target).toEqual({
      name: "fetch",
      file: "helpers.rb",
      line: 2,
    });
    expect(explained?.lines).toEqual([
      "h.fetch (app.rb:2) -> fetch (helpers.rb:2)",
      "  h.fetch (app.rb:2) reads fetch off h (app.rb:1), which contains fetch (helpers.rb:2)",
    ]);
  });

  it("returns null for a name with no expression on that line", () => {
    fs.writeFileSync(path.join(dir, "app.rb"), "x = 1\n");
    const session = new RubyWhySession({ dir });
    expect(session.findExpression("app.rb", 1, "nope")).toBeNull();
  });

  it("returns null for a file the project does not contain", () => {
    fs.writeFileSync(path.join(dir, "app.rb"), "x = 1\n");
    const session = new RubyWhySession({ dir });
    expect(session.findExpression("missing.rb", 1, "x")).toBeNull();
    expect(session.findCallee("missing.rb", 1, 1, "x")).toBeNull();
  });

  it("picks the innermost of two nodes with the same text on a line", () => {
    fs.writeFileSync(
      path.join(dir, "helpers.rb"),
      "class Helpers\n  def self.fetch\n    1\n  end\nend\n",
    );
    fs.writeFileSync(path.join(dir, "app.rb"), "puts Helpers.fetch\n");

    const session = new RubyWhySession({ dir });
    const value = session.findExpression("app.rb", 1, "Helpers.fetch");
    expect(value?.node.type).toBe("call");
    const explained = value === null ? null : session.explain(value);
    expect(explained?.target.file).toBe("helpers.rb");
  });
});
