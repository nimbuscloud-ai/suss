import { describe, expect, it } from "vitest";

import { rubyFactSource } from "./factSource.js";
import { parseRuby } from "./parser.js";
import { factsForFile } from "./project.js";

const FILE = "use.rb";

const SOURCE = `
KIND = "primary"
NAMED = -> { nil }

def make
  -> { nil }
end

OPTIONS = { label: "#{KIND} x", count: 2, comp: Thing }
RENDER = make()
ALIAS = NAMED
`;

async function sourceFor() {
  const tree = await parseRuby(SOURCE);
  const db = factsForFile({ file: FILE, root: tree.rootNode, packs: [] });
  const source = rubyFactSource(db);
  const [options] = source.comesTo?.(`${FILE}#OPTIONS`) ?? [];
  const held = (name: string): string =>
    String(
      db
        .lookup("holdsProperty", 0, options ?? "")
        .find((row) => row[1] === name)?.[2],
    );
  const isFunction = (key: string | null | undefined) =>
    db.lookup("func", 0, key ?? "").length === 1;
  return { source, options, held, isFunction };
}

describe("the Ruby fact source", () => {
  it("gives the hash a constant comes to", async () => {
    const { source, options } = await sourceFor();

    expect(source.shapeOf(options ?? "")).toBe("object");
  });

  it("gives the lambda a constant comes to, and the one a method call gives back", async () => {
    const { source, isFunction } = await sourceFor();

    expect(source.comesTo?.(`${FILE}#ALIAS`)).toHaveLength(1);
    expect(source.comesTo?.(`${FILE}#ALIAS`).every(isFunction)).toBe(true);
    expect(source.comesTo?.(`${FILE}#RENDER`)).toEqual([]);
    expect(isFunction(source.givesBack?.(`${FILE}#RENDER`))).toBe(true);
  });

  it("settles an interpolated string and a number the evaluator folds", async () => {
    const { source, held } = await sourceFor();

    expect(source.evaluatedOf?.(held("label"))).toBe("primary x");
    expect(source.evaluatedOf?.(held("count"))).toBe(2);
    expect(source.evaluatedOf?.(held("comp"))).toBeNull();
  });

  it("gives no class for a callee that is not a constructor, and no anchor call behind a lambda", async () => {
    const { source } = await sourceFor();

    expect(source.constructedClass?.(`${FILE}#RENDER`)).toBeNull();
    expect(
      source.anchorCalls(`${FILE}#NAMED`, {
        origin: "constructed",
        importedFrom: ["Kvcache"],
      }),
    ).toEqual([]);
  });

  it("gives no import specifier, since a Ruby file imports no names", async () => {
    const { source, held } = await sourceFor();

    expect(source.importSpecifierOf?.(held("comp"))).toBeNull();
  });

  it("reads the standard streams and puts the way the language spells them", async () => {
    const tree = await parseRuby(
      [
        "def say(out, line)",
        "  out.write(line)",
        "end",
        "",
        "def run",
        "  $stdout.write({ a: 1 })",
        '  STDERR.write("b")',
        '  say($stdout, "c")',
        '  puts "d"',
        '  log.puts "e"',
        "end",
      ].join("\n"),
    );
    const db = factsForFile({ file: FILE, root: tree.rootNode, packs: [] });
    const source = rubyFactSource(db);
    const writtenTo = new Map(
      db
        .facts("readsProperty")
        .filter((row) => String(row[2]).endsWith("write"))
        .map((row) => [source.textOf(String(row[1])), String(row[1])]),
    );
    const spelled = (name: string, path: string) =>
      source.spellsGlobal?.(writtenTo.get(name) ?? "", path);
    const puts = db
      .facts("call")
      .filter((row) => source.textOf(String(row[1])).endsWith("puts"))
      .map((row) => String(row[0]));

    expect(spelled("$stdout", "$stdout")).toBe(true);
    expect(spelled("STDERR", "STDERR")).toBe(true);
    expect(spelled("out", "$stdout")).toBe(false);
    expect(source.globalsReaching?.(writtenTo.get("out") ?? "")).toEqual([
      "$stdout",
    ]);
    expect(
      puts.map((call) => source.callsGlobal?.(call, "puts")).sort(),
    ).toEqual([false, true]);
    const [hash] = db
      .facts("callArg")
      .filter((row) => source.textOf(String(row[2])) === "{ a: 1 }")
      .map((row) => String(row[2]));
    expect(source.typeShapeOf?.(hash ?? "")).toEqual({
      type: "record",
      properties: { a: { type: "integer" } },
    });
    expect(source.typeShapeOf?.(writtenTo.get("out") ?? "")).toEqual({
      type: "unknown",
    });
  });

  it("gives what JSON's writers and to_json were handed", async () => {
    const tree = await parseRuby(
      [
        "JSON.generate({ a: 1 })",
        "{ b: 2 }.to_json",
        "JSON.generate",
        "Other.generate({ c: 3 })",
        "to_json",
      ].join("\n"),
    );
    const db = factsForFile({ file: FILE, root: tree.rootNode, packs: [] });
    const source = rubyFactSource(db);
    const encodings = db
      .facts("call")
      .map((row) => String(row[0]))
      .map((call) => {
        const found = source.encodedOf?.(call) ?? null;
        return found === null
          ? null
          : `${found.codec} ${source.textOf(found.value)}`;
      });

    expect(encodings.filter((one) => one !== null).sort()).toEqual([
      "json { a: 1 }",
      "json { b: 2 }",
    ]);
  });
});
