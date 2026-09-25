/**
 * A handler passed through a project's own guard, a factory returning a
 * closure that calls the handler, asked about with `suss ask why` in each
 * language. The name resolves to the handler, and the chain says the
 * factory passed its argument through.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { answerQuestion } from "./ask.js";
import { preloadWhySessions } from "./askWhy.js";

let dir: string;

beforeAll(async () => {
  await preloadWhySessions();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-why-factory-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, lines: string[]): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${lines.join("\n")}\n`);
}

function askWhy(question: string): { exitCode: number; text: string } {
  const output = path.join(dir, "answer.txt");
  const { exitCode } = answerQuestion({ question, project: dir, output });
  return { exitCode, text: fs.readFileSync(output, "utf8") };
}

const PASSES_THROUGH = "a factory that passes its argument through";

describe("why a handler passed through a project's guard resolves to it", () => {
  it("follows a TypeScript guard returning an arrow function", () => {
    write("src/guards.ts", [
      "export function requireAdmin(handler: (id: string) => string) {",
      "  return (id: string) => handler(id);",
      "}",
    ]);
    write("src/routes.ts", [
      'import { requireAdmin } from "./guards";',
      "",
      "function listOrders(id: string): string {",
      "  return id;",
      "}",
      "",
      "export const guarded = requireAdmin(listOrders);",
    ]);

    const { exitCode, text } = askWhy(
      "why does guarded at src/routes.ts:7 resolve to listOrders",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to listOrders (src/routes.ts:3)");
    expect(text).toContain(PASSES_THROUGH);
  });

  it("follows a Python guard returning a nested def", () => {
    write("app/guards.py", [
      "def require_admin(handler):",
      "    def checked(*args):",
      "        return handler(*args)",
      "    return checked",
    ]);
    write("app/routes.py", [
      "from app.guards import require_admin",
      "",
      "def list_orders(user):",
      "    return user",
      "",
      "guarded = require_admin(list_orders)",
    ]);

    const { exitCode, text } = askWhy(
      "why does guarded at app/routes.py:6 resolve to list_orders",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to list_orders (app/routes.py:3)");
    expect(text).toContain(PASSES_THROUGH);
  });

  it("follows a Python guard returning a lambda", () => {
    write("app/routes.py", [
      "def require_admin(handler):",
      "    return lambda *args: handler(*args)",
      "",
      "def list_orders(user):",
      "    return user",
      "",
      "guarded = require_admin(list_orders)",
    ]);

    const { exitCode, text } = askWhy(
      "why does guarded at app/routes.py:7 resolve to list_orders",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain(PASSES_THROUGH);
  });

  it("follows a Ruby guard returning a lambda", () => {
    write("app/guards.rb", [
      "module Guards",
      "  def self.require_admin(handler)",
      "    ->(*args) { handler.call(*args) }",
      "  end",
      "end",
    ]);
    write("app/routes.rb", [
      "list_orders = ->(user) { user }",
      "guarded = Guards.require_admin(list_orders)",
    ]);

    const { exitCode, text } = askWhy(
      "why does guarded at app/routes.rb:2 resolve to app/routes.rb:1",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("(app/routes.rb:1)");
    expect(text).toContain(PASSES_THROUGH);
  });
});
