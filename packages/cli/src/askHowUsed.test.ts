import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  restBinding,
  storageBinding,
  summaryIdentifier,
} from "@suss/behavioral-ir";

import { answerQuestion, parseQuestion } from "./ask.js";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";
import type { AnswerJson } from "./ask.js";

const table = storageBinding({
  recognition: "ruby-storage",
  storageSystem: "postgresql",
  scope: "default",
  container: "Settings",
});

function unit(
  id: string,
  file: string,
  line: number,
  rest: Partial<BehavioralSummary> = {},
): BehavioralSummary {
  const name = id.slice(id.lastIndexOf(".") + 1);
  return {
    kind: "library",
    location: { file, range: { start: line, end: line + 4 }, exportName: name },
    identity: {
      name,
      // The Ruby adapter writes a method's path as its class and its name.
      exportPath: id.split("."),
      boundaryBinding: null,
      id: `${file}::${id}`,
    },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
    ...rest,
  };
}

function path1(effects: Effect[], line: number) {
  return {
    id: `t${line}`,
    conditions: [],
    output: { type: "return" as const, value: null },
    effects,
    location: { start: line, end: line + 2 },
    isDefault: true,
  };
}

const lookup = unit("Settings.lookup", "app/models/settings.rb", 3, {
  inputs: [
    { type: "parameter", name: "key", position: 0, role: "key", shape: null },
  ],
  transitions: [
    {
      ...path1(
        [
          {
            type: "interaction",
            binding: table,
            callee: "where(key: key).pick(:value)",
            interaction: {
              class: "storage-access",
              kind: "read",
              fields: ["value"],
              selector: ["key"],
            },
          },
        ],
        3,
      ),
      provenance: [
        {
          at: { slot: "selector", effect: 0, name: "key" },
          from: [{ type: "input", inputRef: "key", path: [] }],
        },
      ],
    },
    {
      ...path1([], 4),
      isDefault: false,
      output: { type: "throw", exceptionType: "KeyError", message: null },
    },
  ],
  gaps: [
    {
      type: "unfollowedCall",
      conditions: [],
      consequence: "unknown",
      description: "an unfollowed call",
      callee: "key.length",
    },
  ],
});

function calling(
  key: string,
  line: number,
  extra: Partial<Effect> = {},
): Effect {
  return {
    type: "invocation",
    callee: "Settings.lookup",
    summary: summaryIdentifier(lookup),
    args: [{ kind: "identifier", name: key }],
    async: false,
    location: { start: line, end: line },
    ...extra,
  } as Effect;
}

function route(
  method: string,
  routePath: string,
  file: string,
  effects: Effect[],
): BehavioralSummary {
  return unit(`PagesController.${method.toLowerCase()}`, file, 2, {
    kind: "handler",
    identity: {
      name: method.toLowerCase(),
      exportPath: [method.toLowerCase()],
      boundaryBinding: restBinding({
        transport: "http",
        method,
        path: routePath,
        recognition: "rails",
      }),
      id: `${file}::PagesController.${method.toLowerCase()}`,
    },
    transitions: [path1(effects, 2)],
  });
}

const summaries: BehavioralSummary[] = [
  lookup,
  route("GET", "/a", "app/controllers/a_controller.rb", [
    calling('"user:#{@user.id}:theme"', 5, {
      preconditions: [
        { type: "opaque", sourceText: "@user", reason: "complexExpression" },
      ],
    }),
  ]),
  route("GET", "/b", "app/controllers/b_controller.rb", [
    calling('"user:#{current.id}:theme"', 6),
  ]),
  route("POST", "/c", "app/controllers/c_controller.rb", [
    {
      type: "invocation",
      callee: "send",
      possibleSummaries: [summaryIdentifier(lookup)],
      args: [],
      async: false,
      location: { start: 7, end: 7 },
    },
  ]),
  unit("Nightly.run", "script/nightly.rb", 1, {
    transitions: [path1([calling('"site:banner"', 2)], 1)],
  }),
];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-how-used-"));
  fs.writeFileSync(path.join(dir, "code.json"), JSON.stringify(summaries));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function asked(
  question: string,
  all = false,
): { text: string; json: AnswerJson | null; exitCode: number } {
  const out = path.join(dir, "answer.txt");
  const { exitCode, answer } = answerQuestion({
    question,
    dir,
    all,
    output: out,
  });
  return { text: fs.readFileSync(out, "utf8"), json: answer, exitCode };
}

describe("how is <unit> used", () => {
  it("parses the question, with or without a question mark", () => {
    expect(parseQuestion("how is Settings used?")).toEqual({
      shape: "usedBy",
      subject: "Settings",
    });
    expect(parseQuestion("How is app/models/settings.rb used")).toEqual({
      shape: "usedBy",
      subject: "app/models/settings.rb",
    });
  });

  it("reads a class name as every method of the class, ahead of a table of the same name", () => {
    const { text, exitCode } = asked("how is Settings used");
    expect(exitCode).toBe(0);
    expect(text.split("\n").slice(0, 2)).toEqual([
      "Settings (app/models/settings.rb:3) reads or writes storage (ruby-storage). 4 calls from 4 files go into it.",
      "It raises KeyError.",
    ]);
    expect(text).toContain(
      '  lookup   4      "user:#{@user.id}:theme" or "user:#{current.id}:theme" (2), nothing for key, "site:banner"',
    );
  });

  it("lists entry points, the possible ones apart, the conditions and the gaps", () => {
    const { text } = asked("how is Settings.lookup used");
    expect(text).toContain(
      "  PagesController  3      GET /a, GET /b; possibly POST /c",
    );
    expect(text).toContain(
      "  1 entry point reaches it only through a call that picks its function at run time: POST /c.",
    );
    expect(text).toContain(
      "    app/controllers/a_controller.rb:5  Settings.lookup  when @user",
    );
    expect(text).toContain(
      "    app/models/settings.rb:3 Settings.lookup makes a call suss did not follow: key.length",
    );
    expect(text).toContain(
      "    script/nightly.rb:1 Nightly.run calls it, and no entry point in these summaries reaches Nightly.run",
    );
  });

  it("gives groups, callers, calls and gaps as items an agent can parse", () => {
    const { json } = asked("how is Settings.lookup used");
    const items = (json?.items ?? []) as Array<Record<string, unknown>>;
    expect([...new Set(items.map((item) => item.kind))]).toEqual([
      "group",
      "caller",
      "call",
      "gap",
    ]);
    expect(json?.construct).toEqual(
      expect.objectContaining({
        label: "app/models/settings.rb::Settings.lookup",
        calls: 4,
        files: 4,
        outcomes: [{ kind: "throws", type: "KeyError" }],
      }),
    );
  });

  it("answers about the table when the boundary is spelled", () => {
    const { text } = asked("how is postgresql:Settings used");
    expect(text.split("\n")[0]).toBe(
      "postgresql:Settings touches no boundary suss reads. 1 call from 1 file go into it.",
    );
    expect(text).toContain("  reads    1      key");
  });

  it("says what it needs when nothing is there", () => {
    const { text, exitCode } = asked("how is Rails.cache used");
    expect(exitCode).toBe(1);
    expect(text).toContain("No summary here is Rails.cache.");
    expect(text).toContain(
      "Extract the code that defines or calls Rails.cache",
    );
  });
});
