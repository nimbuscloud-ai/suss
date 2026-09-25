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

  it("follows a bare module method read to its definition", () => {
    fs.writeFileSync(
      path.join(dir, "helpers.rb"),
      "module Helpers\n  def self.fetch\n    1\n  end\nend\n",
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
  });

  it("follows a method read through a nested module", () => {
    fs.writeFileSync(
      path.join(dir, "helpers.rb"),
      "module A\n  module B\n    def self.fetch\n      1\n    end\n  end\nend\n",
    );
    fs.writeFileSync(path.join(dir, "app.rb"), "x = A::B.fetch\n");

    const session = new RubyWhySession({ dir });
    const value = session.findExpression("app.rb", 1, "fetch");
    expect(value).not.toBeNull();
    const explained = value === null ? null : session.explain(value);

    expect(explained).not.toBeNull();
    expect(explained?.target).toEqual({
      name: "fetch",
      file: "helpers.rb",
      line: 3,
    });
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
      "fetch (app.rb:2) -> fetch (helpers.rb:2)",
      "  fetch (app.rb:2) reads fetch off h (app.rb:1), which contains fetch (helpers.rb:2)",
    ]);
  });

  describe("an instance variable a before_action sets", () => {
    const model = (name: string): string =>
      `class ${name} < ApplicationRecord\n  def publish\n    true\n  end\nend\n`;
    const controller = (name: string, model: string): string =>
      [
        `class ${name} < ApplicationController`,
        "  before_action :set_report",
        "",
        "  def show",
        "    @report.publish",
        "  end",
        "",
        "  private",
        "",
        "  def set_report",
        `    @report = ${model}.new(title: "draft")`,
        "  end",
        "end",
        "",
      ].join("\n");

    // Each copy is one more place a class is made, and the rules that
    // follow a value under the place it was made join every such place
    // against every value, so the copies make that cost visible.
    const writeProject = (copies: number): void => {
      fs.mkdirSync(path.join(dir, "app/models"), { recursive: true });
      fs.mkdirSync(path.join(dir, "app/controllers"), { recursive: true });
      fs.writeFileSync(path.join(dir, "app/models/report.rb"), model("Report"));
      fs.writeFileSync(
        path.join(dir, "app/controllers/reports_controller.rb"),
        controller("ReportsController", "Report"),
      );
      for (let i = 0; i < copies; i++) {
        fs.writeFileSync(
          path.join(dir, `app/models/report${i}.rb`),
          model(`Report${i}`),
        );
        fs.writeFileSync(
          path.join(dir, `app/controllers/reports${i}_controller.rb`),
          controller(`Reports${i}Controller`, `Report${i}`),
        );
      }
    };

    const explainPublish = () => {
      const session = new RubyWhySession({ dir });
      const value = session.findExpression(
        "app/controllers/reports_controller.rb",
        5,
        "publish",
      );
      return value === null ? null : session.explain(value);
    };

    it("follows a method called on it to the class it was made from", () => {
      writeProject(0);
      const explained = explainPublish();

      expect(explained?.target).toEqual({
        name: "publish",
        file: "app/models/report.rb",
        line: 2,
      });
      expect(explained?.lines).toEqual([
        "publish (app/controllers/reports_controller.rb:5) -> publish (app/models/report.rb:2)",
        "  publish (app/controllers/reports_controller.rb:5) reads publish off @report (app/controllers/reports_controller.rb:5), which contains publish (app/models/report.rb:2)",
      ]);
    });

    it("derives only what the proof can use when many classes are made", () => {
      writeProject(100);
      const explained = explainPublish();

      expect(explained?.target.file).toBe("app/models/report.rb");
      const stats = explained?.stats;
      expect(stats).toBeDefined();
      // Joining the hundred places a class is made against every value
      // would derive far more than the facts the project has.
      expect(stats?.derivedFacts).toBeLessThan(3 * (stats?.baseFacts ?? 0));
    }, 20_000);
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
