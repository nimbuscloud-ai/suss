import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { parseRuby } from "../parser.js";
import { usesOf } from "./resolve.js";
import { emitValueFacts } from "./values.js";

/** A method that builds an app into a local and mounts on it, then runs `body`. */
function builder(body: string[]): string {
  return [
    "class Boot",
    "  def build(holder, apps)",
    "    app = Rack::Builder.new",
    '    app.map("/t")',
    ...body.map((line) => `    ${line}`),
    "  end",
    "end",
    "",
  ].join("\n");
}

/** Where the local `app` goes, read the way a router reader would ask. */
async function usesOfApp(body: string[]) {
  const tree = await parseRuby(builder(body));
  const db = new Database();
  emitValueFacts(db, "f.rb", tree.rootNode);
  const appKey = db
    .facts("binds")
    .map((row) => String(row[0]))
    .find((key) => key.endsWith("#app"));
  expect(appKey, "the local was not bound").toBeDefined();
  return usesOf(db, appKey as string);
}

describe("where a Ruby local goes", () => {
  it("stays put when the only use calls a method on it", async () => {
    expect(await usesOfApp(["nil"])).toEqual({
      passedOn: false,
      methodsCalled: ["map"],
    });
  });

  it("lists a method that may serve it", async () => {
    const uses = await usesOfApp(["app.run", "nil"]);
    expect(uses.passedOn).toBe(false);
    expect([...uses.methodsCalled].sort()).toEqual(["map", "run"]);
  });

  it("lists the method a part of it is read through, since Ruby calls it", async () => {
    const uses = await usesOfApp(["serve(app.to_app)", "nil"]);
    expect(uses.methodsCalled).toContain("to_app");
  });

  it.each([
    ["returns it", ["return app"]],
    ["returns it as the last expression", ["app"]],
    ["returns it with another value", ["return app, holder"]],
    ["returns it in a hash", ["{ app: app }"]],
    ["returns it under a computed key", ["{ holder => app }"]],
    ["returns it in an array", ["[app]"]],
    ["hands it to a call", ["serve(app)", "nil"]],
    ["hands it to a call by keyword", ["serve(app: app)", "nil"]],
    ["pushes it onto a list", ["apps.push(app)", "nil"]],
    ["appends it to a list", ["apps << app", "nil"]],
    ["stores it in an instance variable", ["@app = app", "nil"]],
    ["stores it in a global", ["$app = app", "nil"]],
    ["stores it in a class variable", ["@@app = app", "nil"]],
    ["writes it through a parameter's setter", ["holder.app = app", "nil"]],
    ["writes it through self's setter", ["self.app = app", "nil"]],
    ["writes it under a key", ["apps[:t] = app", "nil"]],
    ["binds it to a second name", ["served = app", "nil"]],
    ["yields it", ["yield app", "nil"]],
    ["gives it back from a block", ["foo { app }", "nil"]],
    ["gives it back from a do block", ["foo do", "  app", "end", "nil"]],
    ["passes it inside a block", ["Thread.new { serve(app) }", "nil"]],
    ["captures it in a lambda", ["-> { app }"]],
    ["returns it from a conditional", ["ready ? app : nil"]],
    ["returns it from an if", ["if ready", "  app", "end"]],
    [
      "returns it from an elsif",
      ["if ready", "  nil", "elsif other", "  app", "end"],
    ],
    ["returns it from an else", ["if ready", "  nil", "else", "  app", "end"]],
    ["returns it from an unless", ["unless ready", "  app", "end"]],
    ["returns it behind a modifier", ["app if ready"]],
    ["returns it after &&", ["ready && app"]],
    ["returns it as a fallback", ["holder || app"]],
    ["calls it", ["app.call(holder)", "nil"]],
  ])("is passed on when the method %s", async (_, body) => {
    expect((await usesOfApp(body)).passedOn).toBe(true);
  });
});
