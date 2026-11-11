import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { preloadRubyGrammar } from "./parser.js";
import { moduleOpsForFile } from "./project.js";

let dir: string;

beforeAll(async () => {
  await preloadRubyGrammar();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-module-ops-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function opsOf(source: string) {
  const file = path.join(dir, "engine.rb");
  fs.writeFileSync(file, source);
  return moduleOpsForFile(file);
}

describe("one Ruby file read on its own as module ops", () => {
  it("lists every class and module the file writes, by its full name, and whether it extends a library base", () => {
    const module = opsOf(
      "module Billing\n" +
        "  class Engine < ::Rails::Engine\n" +
        "    isolate_namespace Billing\n" +
        "  end\n" +
        "end\n" +
        "class Other < Rails::Engine\nend\n",
    );
    const engine = { from: ["Rails"], named: ["Engine"] };
    expect(
      module.classes().map((cls) => [cls.name(), cls.inherits(engine)]),
    ).toEqual([
      ["Billing", false],
      ["Billing::Engine", true],
      ["Other", true],
    ]);
  });

  it("evaluates a value with a block's variables bound, and a name with nothing written to it as nothing", () => {
    const module = opsOf(
      '%w[users].each do |root|\n  get "#{root}/x", to: target\nend\n',
    );
    const [loop] = module.bodyCalls();
    const [get] = loop?.block?.()?.bodyCalls?.() ?? [];
    const bindings = new Map([["root", "users"]]);
    expect(get?.valueAt(0)?.evaluatedWith?.(bindings)).toBe("users/x");
    expect(get?.keywordAt?.("to")?.evaluatedWith?.(bindings)).toBeNull();
  });
});
