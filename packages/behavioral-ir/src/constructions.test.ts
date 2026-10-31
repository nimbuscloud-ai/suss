/**
 * A repository method every model shares has one summary, and a reader
 * copies it once for each construction a call runs it on.
 */

import { describe, expect, it } from "vitest";

import { placeReceivers, TargetPlacements } from "./callLinks.js";
import { dropIdleReceivers, withConstructions } from "./constructions.js";
import { originalIdOf } from "./summaryId.js";

import type { BehavioralSummary, Effect } from "./index.js";

type Invocation = Extract<Effect, { type: "invocation" }>;

const TOOLS = "app/main.py:12:12";
const TAGS = "app/main.py:20:12";
const OTHER = "app/main.py:30:5";

function summary(id: string, effects: Effect[], start = 1): BehavioralSummary {
  return {
    kind: "handler",
    location: {
      file: "app/repos.py",
      range: { start, end: start + 4 },
      exportName: id,
    },
    identity: { id, name: id, exportPath: [id], boundaryBinding: null },
    inputs: [],
    transitions: [
      {
        id: "t1",
        conditions: [],
        output: { type: "void" },
        effects,
        location: { start, end: start + 4 },
        isDefault: true,
      },
    ],
    gaps: [],
    confidence: { source: "inferred_static", level: "high" },
  };
}

function call(callee: string, over: Partial<Invocation> = {}): Invocation {
  return { type: "invocation", callee, args: [], async: false, ...over };
}

const selectModel: Effect = {
  type: "interaction",
  binding: {
    transport: "sqlalchemy",
    semantics: {
      name: "storage",
      storageSystem: "postgresql",
      scope: "default",
      container: null,
      accessPath: null,
    },
    recognition: "sqlalchemy",
  },
  callee: "select(self.model)",
  containerByConstruction: { [TOOLS]: "Tool", [TAGS]: "Tag" },
  interaction: {
    class: "storage-access",
    kind: "read",
    fields: ["*"],
  },
};

const getOne = summary("get_one", [selectModel], 10);
const first = summary(
  "first",
  [call("self.get_one", { summary: "get_one", onOwnReceiver: true })],
  20,
);

function byId(summaries: BehavioralSummary[]): Map<string, BehavioralSummary> {
  return new Map(summaries.map((one) => [one.identity.id as string, one]));
}

function containerOf(one: BehavioralSummary | undefined): unknown {
  const effect = one?.transitions[0]?.effects[0];
  return effect?.type === "interaction" &&
    effect.binding.semantics.name === "storage"
    ? effect.binding.semantics.container
    : undefined;
}

function linkOf(one: BehavioralSummary | undefined): Invocation | undefined {
  const effect = one?.transitions[0]?.effects[0];
  return effect?.type === "invocation" ? effect : undefined;
}

describe("withConstructions", () => {
  it("copies the callee for the construction a call runs it on, with that table", () => {
    const route = summary("route", [
      call("repo.get_one", {
        summary: "get_one",
        receiverConstructions: [TOOLS],
      }),
    ]);
    const read = byId(withConstructions([route, getOne]));
    const copy = read.get(`get_one on ${TOOLS}`);

    expect(linkOf(read.get("route"))?.summary).toBe(`get_one on ${TOOLS}`);
    expect(copy?.receiverConstruction).toBe(TOOLS);
    expect(containerOf(copy)).toBe("Tool");
    expect(containerOf(read.get("get_one"))).toBeNull();
  });

  it("makes one copy for two callers on the same construction", () => {
    const callers = ["route", "other"].map((id) =>
      summary(id, [
        call("repo.get_one", {
          summary: "get_one",
          receiverConstructions: [TOOLS],
        }),
      ]),
    );
    const read = withConstructions([...callers, getOne]);

    expect(read.map((one) => one.identity.id)).toEqual([
      "route",
      "other",
      "get_one",
      `get_one on ${TOOLS}`,
    ]);
  });

  it("keeps the method itself for a construction it does nothing different on", () => {
    const route = summary("route", [
      call("repo.get_one", {
        summary: "get_one",
        receiverConstructions: [OTHER],
      }),
    ]);
    const read = withConstructions([route, getOne]);

    expect(read).toHaveLength(2);
    expect(linkOf(byId(read).get("route"))?.summary).toBe("get_one");
  });

  it("offers the method itself beside a copy when only one construction gives a table", () => {
    const route = summary("route", [
      call("repo.get_one", {
        summary: "get_one",
        receiverConstructions: [TOOLS, OTHER],
      }),
    ]);
    const linked = linkOf(
      byId(withConstructions([route, getOne])).get("route"),
    );

    expect(linked?.possibleSummaries).toEqual([
      `get_one on ${TOOLS}`,
      "get_one",
    ]);
  });

  it("keeps a call on the method's own receiver on the same construction", () => {
    const route = summary("route", [
      call("repo.first", { summary: "first", receiverConstructions: [TAGS] }),
    ]);
    const read = byId(withConstructions([route, first, getOne]));

    expect(linkOf(read.get(`first on ${TAGS}`))?.summary).toBe(
      `get_one on ${TAGS}`,
    );
    expect(containerOf(read.get(`get_one on ${TAGS}`))).toBe("Tag");
    expect(linkOf(read.get("first"))?.summary).toBe("get_one");
  });

  it("lists every copy as a possible callee for a receiver made at either of two", () => {
    const route = summary("route", [
      call("repo.get_one", {
        summary: "get_one",
        receiverConstructions: [TOOLS, TAGS],
      }),
    ]);
    const linked = linkOf(
      byId(withConstructions([route, getOne])).get("route"),
    );

    expect(linked?.summary).toBeUndefined();
    expect(linked?.possibleSummaries).toEqual([
      `get_one on ${TOOLS}`,
      `get_one on ${TAGS}`,
    ]);
  });

  it("leaves a call alone when its callee is not among the summaries", () => {
    const route = summary("route", [
      call("repo.get_one", {
        summary: "absent",
        receiverConstructions: [TOOLS],
      }),
    ]);
    const read = withConstructions([route]);

    expect(read).toHaveLength(1);
    expect(linkOf(read[0])?.summary).toBe("absent");
  });
});

describe("dropIdleReceivers", () => {
  it("keeps the records on calls into a method that does something different per construction", () => {
    const route = summary("route", [
      call("repo.first", { summary: "first", receiverConstructions: [TOOLS] }),
    ]);
    const summaries = [route, structuredClone(first), getOne];

    dropIdleReceivers(summaries);

    expect(linkOf(summaries[0])?.receiverConstructions).toEqual([TOOLS]);
    expect(linkOf(summaries[1])?.onOwnReceiver).toBe(true);
  });

  it("takes them off calls into a method that does the same thing on every construction", () => {
    const plain = summary("plain", [], 40);
    const route = summary("route", [
      call("repo.plain", { summary: "plain", receiverConstructions: [TOOLS] }),
      call("self.plain", { summary: "plain", onOwnReceiver: true }),
      call("repo.get_one", {
        summary: "get_one",
        receiverConstructions: [OTHER],
      }),
    ]);

    dropIdleReceivers([route, plain, getOne]);

    for (const effect of route.transitions[0]?.effects ?? []) {
      expect(effect).not.toHaveProperty("receiverConstructions");
      expect(effect).not.toHaveProperty("onOwnReceiver");
    }
  });
});

describe("originalIdOf", () => {
  it("gives the id a copy was made from", () => {
    const route = summary("route", [
      call("repo.get_one", {
        summary: "get_one",
        receiverConstructions: [TAGS],
      }),
    ]);
    const copy = byId(withConstructions([route, getOne])).get(
      `get_one on ${TAGS}`,
    );

    expect(copy === undefined ? null : originalIdOf(copy)).toBe("get_one");
    expect(originalIdOf(getOne)).toBe("get_one");
  });
});

describe("placeReceivers", () => {
  it("records what each callee text runs on", () => {
    const placements = new TargetPlacements();
    placements.placeReceiver("self.get_one", { own: true });
    placements.placeReceiver("repo.get_one", { made: [TOOLS] });
    const route = summary("route", [
      call("self.get_one"),
      call("repo.get_one"),
    ]);

    placeReceivers(route, placements.receivers);

    const [own, made] = route.transitions[0]?.effects as Invocation[];
    expect(own?.onOwnReceiver).toBe(true);
    expect(made?.receiverConstructions).toEqual([TOOLS]);
  });

  it("leaves a summary alone with nothing to record", () => {
    const repo = summary("get_one", [selectModel]);
    const before = structuredClone(repo);

    placeReceivers(repo, undefined);
    placeReceivers(repo, new Map([["select(self.model)", { own: true }]]));

    expect(repo).toEqual(before);
  });

  it("drops a callee text two calls disagree about", () => {
    const placements = new TargetPlacements();
    placements.placeReceiver("repo.get_one", { made: [TOOLS] });
    placements.placeReceiver("repo.get_one", { made: [TAGS] });
    placements.placeReceiver("other.get_one", { made: [TOOLS] });
    placements.placeReceiver("other.get_one", null);

    expect([...placements.receivers.keys()]).toEqual([]);
  });
});
