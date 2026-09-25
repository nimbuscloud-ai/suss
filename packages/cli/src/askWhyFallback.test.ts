/**
 * A client taken from a fallback, `injected or make_client()`, asked about
 * with `suss ask why` in Python and Ruby. The fallback's value is one of
 * its branches, and the injected branch makes no claim, so a method called
 * on the client resolves to the one the constructed class declares.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-why-fallback-"));
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

describe("why a method called on a fallback resolves to it", () => {
  it("follows a Python `or` into the branch that builds the client", () => {
    write("app/orders.py", [
      "class OrdersClient:",
      "    def send(self, order):",
      "        return order",
      "",
      "",
      "def make_client():",
      "    return OrdersClient()",
      "",
      "",
      "def submit(order, injected=None):",
      "    client = injected or make_client()",
      "    return client.send(order)",
    ]);

    const { exitCode, text } = askWhy(
      "why does client.send at app/orders.py:12 resolve to send",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to send (app/orders.py:2)");
    expect(text).toContain("which contains send (app/orders.py:2)");
  });

  it("follows a Ruby `||` the same way", () => {
    write("app/orders.rb", [
      "class OrdersClient",
      "  def deliver(order)",
      "    order",
      "  end",
      "end",
      "",
      "def make_client",
      "  OrdersClient.new",
      "end",
      "",
      "def submit(order, injected = nil)",
      "  client = injected || make_client",
      "  client.deliver(order)",
      "end",
    ]);

    const { exitCode, text } = askWhy(
      "why does deliver at app/orders.rb:13 resolve to deliver",
    );

    expect(exitCode).toBe(0);
    expect(text).toContain("resolves to deliver (app/orders.rb:2)");
    expect(text).toContain("which contains deliver (app/orders.rb:2)");
  });
});
