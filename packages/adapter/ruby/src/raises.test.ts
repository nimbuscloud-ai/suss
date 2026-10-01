import { describe, expect, it } from "vitest";

import { parseRuby } from "./parser.js";
import { escapingRaises, raisedClassRef } from "./raises.js";

import type { RbNode } from "./parser.js";

async function methodOf(source: string): Promise<RbNode> {
  const root = (await parseRuby(source)).rootNode as unknown as RbNode;
  const method = root.descendantsOfType("method")[0];
  if (method === undefined || method === null) {
    throw new Error("the source defines no method");
  }
  return method as RbNode;
}

async function raisedIn(source: string): Promise<string[]> {
  return escapingRaises(await methodOf(source)).map((call) => call.text);
}

async function classOf(statement: string, nesting: string[] = []) {
  const [call] = escapingRaises(await methodOf(`def a\n  ${statement}\nend\n`));
  return call === undefined ? undefined : raisedClassRef(call, nesting);
}

describe("the raises that leave a method", () => {
  it("finds a raise under a condition and one in a block the method runs", async () => {
    expect(
      await raisedIn(`
def update
  raise Denied if locked?
  items.each { |item| fail Invalid unless item.ok? }
end
`),
    ).toEqual(["raise Denied", "fail Invalid"]);
  });

  it("leaves out a raise a rescue in the same method catches", async () => {
    expect(
      await raisedIn(`
def update
  begin
    raise Retryable
  rescue Retryable
    raise Gone
  end
  value = (raise(Broken) rescue nil)
  other = (compute rescue raise(Fallback))
end
`),
    ).toEqual(["raise Gone", "raise(Fallback)"]);
    expect(
      await raisedIn(`
def update
  raise Late
rescue Denied
  head :forbidden
end
`),
    ).toEqual([]);
  });

  it("leaves out a raise in a block the method only defines", async () => {
    expect(
      await raisedIn(`
def update
  check = -> { raise Denied }
  head :ok
end
`),
    ).toEqual([]);
  });
});

describe("the class a raise raises", () => {
  it("reads a constant, a constant with a message, and a constructed instance", async () => {
    expect(await classOf("raise Denied", ["Api"])).toEqual({
      text: "Denied",
      candidates: ["Api::Denied", "Denied"],
    });
    expect(
      (await classOf('raise Billing::LimitReached, "over"'))?.candidates,
    ).toEqual(["Billing::LimitReached"]);
    expect((await classOf('raise Denied.new("why")'))?.candidates).toEqual([
      "Denied",
    ]);
  });

  it("reads a message alone as RuntimeError", async () => {
    expect((await classOf('raise "no account"'))?.candidates).toEqual([
      "RuntimeError",
    ]);
  });

  it("reads nothing from an exception the source computes", async () => {
    expect(await classOf("raise error")).toBeNull();
    expect(await classOf("raise build_error(code)")).toBeNull();
    expect(await classOf("raise()")).toBeNull();
  });
});
