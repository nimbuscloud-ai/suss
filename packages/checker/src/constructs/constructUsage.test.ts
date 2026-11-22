import { describe, expect, it } from "vitest";

import {
  restBinding,
  storageBinding,
  withWrapperMetadata,
} from "@suss/behavioral-ir";

import { readCallFacts } from "../calls/callFacts.js";
import { touchesOfUnits } from "../reach/touches.js";
import { constructUsage } from "./constructUsage.js";

import type {
  BehavioralSummary,
  Effect,
  Predicate,
  Transition,
} from "@suss/behavioral-ir";
import type { RecordedArgument } from "./argumentSpelling.js";

const FILE = "app/store.rb";

interface UnitSpec {
  id: string;
  file?: string;
  line?: number;
  kind?: BehavioralSummary["kind"];
  binding?: BehavioralSummary["identity"]["boundaryBinding"];
  parameters?: string[];
  effects?: Effect[];
  transitions?: Transition[];
  gaps?: BehavioralSummary["gaps"];
  metadata?: Record<string, unknown>;
}

function unit(spec: UnitSpec): BehavioralSummary {
  const file = spec.file ?? FILE;
  const line = spec.line ?? 1;
  const name = spec.id.slice(spec.id.lastIndexOf(".") + 1);
  return {
    kind: spec.kind ?? "library",
    location: {
      file,
      range: { start: line, end: line + 3 },
      exportName: name,
    },
    identity: {
      name,
      exportPath: [name],
      boundaryBinding: spec.binding ?? null,
      id: `${file}::${spec.id}`,
    },
    inputs: (spec.parameters ?? []).map((parameter, position) => ({
      type: "parameter" as const,
      name: parameter,
      position,
      role: parameter,
      shape: null,
    })),
    transitions: spec.transitions ?? [
      {
        id: `${spec.id}:1`,
        conditions: [],
        output: { type: "return", value: null },
        effects: spec.effects ?? [],
        location: { start: line, end: line + 3 },
        isDefault: true,
      },
    ],
    gaps: spec.gaps ?? [],
    confidence: { source: "inferred_static", level: "high" },
    ...(spec.metadata === undefined ? {} : { metadata: spec.metadata }),
  };
}

function call(
  callee: string,
  target: BehavioralSummary,
  args: RecordedArgument[],
  line: number,
  preconditions?: Predicate[],
): Effect {
  return {
    type: "invocation",
    callee,
    summary: target.identity.id,
    args,
    async: false,
    location: { start: line, end: line },
    ...(preconditions === undefined ? {} : { preconditions }),
  };
}

function route(
  method: string,
  path: string,
  file: string,
  effects: Effect[],
): BehavioralSummary {
  return unit({
    id: `RoutesController.${method.toLowerCase()}${path.replace(/\W/g, "_")}`,
    file,
    kind: "handler",
    binding: restBinding({
      transport: "http",
      method,
      path,
      recognition: "rails",
    }),
    effects,
  });
}

const table = storageBinding({
  recognition: "ruby-storage",
  storageSystem: "postgresql",
  scope: "default",
  container: "settings",
});

/** A store whose `lookup` selects rows by its `key` parameter, and whose `bump` passes its key on. */
function store() {
  const lookup = unit({
    id: "Store.lookup",
    line: 5,
    parameters: ["key"],
    transitions: [
      {
        id: "lookup:1",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
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
        location: { start: 5, end: 7 },
        isDefault: true,
        provenance: [
          {
            at: { slot: "selector", effect: 0, name: "key" },
            from: [{ type: "input", inputRef: "key", path: [] }],
          },
        ],
      },
    ],
  });
  const bump = unit({
    id: "Store.bump",
    line: 10,
    parameters: ["key", "by"],
    effects: [
      call("lookup", lookup, [{ kind: "identifier", name: "key" }], 11),
    ],
  });
  const save = unit({
    id: "Store.save",
    line: 15,
    parameters: ["key", "value"],
  });
  return { lookup, bump, save };
}

function usageOf(summaries: BehavioralSummary[], subject: BehavioralSummary[]) {
  return constructUsage(summaries, readCallFacts(summaries), {
    kind: "units",
    units: subject,
  });
}

describe("constructUsage on a key-value store", () => {
  const { lookup, bump, save } = store();
  const helper = unit({
    id: "Report.theme_for",
    file: "app/report.rb",
    line: 3,
    parameters: ["user"],
    effects: [
      call(
        "Store.lookup",
        lookup,
        [{ kind: "identifier", name: '"user:#{user.id}:theme"' }],
        4,
      ),
    ],
  });
  const index = route("GET", "/orders", "app/orders_controller.rb", [
    call(
      "Store.lookup",
      lookup,
      [{ kind: "identifier", name: '"user:#{@user.id}:theme"' }],
      8,
      [{ type: "opaque", sourceText: "@user", reason: "complexExpression" }],
    ),
    call(
      "Report.theme_for",
      helper,
      [{ kind: "identifier", name: "@user" }],
      9,
    ),
  ]);
  const banner = route("GET", "/banner", "app/banner_controller.rb", [
    call("Store.lookup", lookup, [{ kind: "string", value: "site:banner" }], 4),
    call("Store.bump", bump, [{ kind: "string", value: "site:views" }], 5),
    call("Store.save", save, [{ kind: "string", value: "site:seen" }], 6),
  ]);
  const unreached = unit({
    id: "Nightly.run",
    file: "script/nightly.rb",
    effects: [call("Store.bump", bump, [], 3)],
  });
  const stopped = unit({
    id: "Admin.show",
    file: "app/admin_controller.rb",
    kind: "handler",
    binding: restBinding({
      transport: "http",
      method: "GET",
      path: "/admin",
      recognition: "rails",
    }),
    gaps: [
      {
        type: "unfollowedCall",
        conditions: [],
        consequence: "unknown",
        description: "an unfollowed call",
        callee: "config.lookup",
      },
    ],
  });
  const summaries = [
    lookup,
    bump,
    save,
    helper,
    index,
    banner,
    unreached,
    stopped,
  ];
  const usage = usageOf(summaries, [lookup, bump, save]);

  it("groups calls by the key each passes, with the computed parts blanked", () => {
    const lookupGroups = usage.groups.filter(
      (group) => group.through === "lookup",
    );
    expect(
      lookupGroups.map((group) => [group.values[0]?.blanked, group.calls]),
    ).toEqual([
      ['"user:#{_}:theme"', 2],
      ['"site:banner"', 1],
    ]);
    expect(lookupGroups[0]?.spellings.map((one) => one.spelled).sort()).toEqual(
      ['"user:#{@user.id}:theme"', '"user:#{user.id}:theme"'],
    );
  });

  it("counts a parameter a method passes on to one that selects by it", () => {
    const bumped = usage.groups.filter((group) => group.through === "bump");
    expect(bumped.map((group) => group.values)).toEqual([
      [{ parameter: "key", blanked: null }],
      [{ parameter: "key", blanked: '"site:views"' }],
    ]);
  });

  it("leaves a parameter that reaches no boundary out of the group", () => {
    const saved = usage.groups.filter((group) => group.through === "save");
    expect(saved).toEqual([expect.objectContaining({ calls: 1, values: [] })]);
  });

  it("lists callers by class or file, with the entry points that reach each", () => {
    const byOwner = Object.fromEntries(
      usage.callers.map((caller) => [
        caller.owner,
        caller.reachedBy.map((entry) => entry.boundary),
      ]),
    );
    expect(byOwner).toEqual({
      RoutesController: ["GET /banner", "GET /orders"],
      Report: ["GET /orders"],
      Nightly: [],
    });
  });

  it("keeps the condition a call runs under", () => {
    const guarded = usage.calls.find((one) => one.line === 8);
    expect(guarded?.conditions).toEqual([
      { type: "opaque", sourceText: "@user", reason: "complexExpression" },
    ]);
  });

  it("says which caller nothing reaches, and which unfollowed call has a member's name", () => {
    expect(
      usage.gaps.map((gap) => [
        gap.kind,
        gap.name,
        "callee" in gap ? gap.callee : "",
      ]),
    ).toEqual([
      ["unreached", "Nightly.run", ""],
      ["unfollowed", "Admin.show", "config.lookup"],
    ]);
    const unfollowed = usage.gaps.find((gap) => gap.kind === "unfollowed");
    expect(
      unfollowed?.kind === "unfollowed" &&
        unfollowed.reachedBy.map((entry) => entry.boundary),
    ).toEqual(["GET /admin"]);
  });

  it("reads storage as what the construct touches", () => {
    expect(usage.touches).toEqual([
      { class: "storage-access", recognition: ["ruby-storage"] },
    ]);
  });
});

describe("constructUsage on one method of a class", () => {
  it("takes a method of the same class that calls the subject as a way through", () => {
    const fetch = unit({ id: "Client.fetch", line: 20, parameters: ["url"] });
    const fetchQuietly = unit({
      id: "Client.fetch_quietly",
      line: 30,
      parameters: ["url"],
      effects: [
        call("fetch", fetch, [{ kind: "identifier", name: "url" }], 31),
      ],
    });
    const direct = route("POST", "/hooks", "app/hooks_controller.rb", [
      call(
        "Client.new.fetch",
        fetch,
        [{ kind: "string", value: "https://a" }],
        3,
      ),
    ]);
    const through = route("GET", "/preview", "app/preview_controller.rb", [
      call("Client.new.fetch_quietly", fetchQuietly, [], 3),
    ]);
    const summaries = [fetch, fetchQuietly, direct, through];
    const usage = usageOf(summaries, [fetch]);

    expect(
      usage.members.map((member) => [member.name, member.through]),
    ).toEqual([
      ["Client.fetch", undefined],
      ["Client.fetch_quietly", true],
    ]);
    expect(usage.groups.map((group) => [group.through, group.calls])).toEqual([
      ["fetch", 1],
      ["fetch_quietly", 1],
    ]);
  });

  it("reads outcomes from the pack's summary ahead of the one reach built", () => {
    const transitions = (outputs: Transition["output"][]): Transition[] =>
      outputs.map((output, at) => ({
        id: `t${at}`,
        conditions: [],
        output,
        effects: [],
        location: { start: 20, end: 23 },
        isDefault: at === 0,
      }));
    const client = unit({
      id: "fetch",
      line: 20,
      kind: "client",
      binding: restBinding({
        transport: "http",
        method: "GET",
        path: null,
        recognition: "net-http",
      }),
      transitions: transitions([
        { type: "throw", exceptionType: "DNSError", message: null },
        { type: "return", value: { type: "null" } },
      ]),
    });
    const library = unit({
      id: "Client.fetch",
      line: 20,
      transitions: transitions([{ type: "return", value: null }]),
    });
    const caller = route("GET", "/x", "app/x_controller.rb", [
      call("Client.new.fetch", library, [], 3),
    ]);
    const summaries = [client, library, caller];
    const usage = usageOf(summaries, [library]);

    expect(usage.outcomes).toEqual([
      { kind: "throws", type: "DNSError" },
      { kind: "returnsNothing" },
    ]);
    expect(usage.touches).toEqual([
      { class: "service-call", recognition: ["net-http"] },
    ]);
    expect(usage.calls.map((one) => one.caller)).toEqual([
      "app/x_controller.rb::RoutesController.get_x",
    ]);
  });
});

describe("constructUsage on a filter", () => {
  it("counts each unit the filter wraps, and reads the response it adds", () => {
    const filter = unit({
      id: "Auth.require_login",
      file: "app/auth.rb",
      kind: "middleware",
      transitions: [
        {
          id: "f:1",
          conditions: [
            {
              type: "negation",
              operand: {
                type: "opaque",
                sourceText: "@user",
                reason: "complexExpression",
              },
            },
          ],
          output: {
            type: "response",
            statusCode: { type: "literal", value: 302 },
            body: null,
            headers: {},
          },
          effects: [
            call("redirect_to", unit({ id: "Auth.redirect_to" }), [], 3),
          ],
          location: { start: 2, end: 3 },
          isDefault: false,
          metadata: {},
        },
      ],
    });
    const wrapped = (path: string) => {
      // One action per file, since two actions at one place are one function.
      const base = route("GET", path, `app/pages${path}_controller.rb`, []);
      return {
        ...base,
        metadata: withWrapperMetadata(undefined, {
          applied: [{ file: "app/auth.rb", name: "require_login" }],
        }),
        transitions: [
          ...base.transitions,
          {
            id: "composed",
            conditions: [],
            output: {
              type: "response" as const,
              statusCode: { type: "literal" as const, value: 302 },
              body: null,
              headers: {},
            },
            effects: [call("redirect_to", filter, [], 3)],
            location: { start: 2, end: 3 },
            isDefault: false,
            metadata: withWrapperMetadata(undefined, {
              from: { file: "app/auth.rb", name: "require_login" },
            }),
          },
        ],
      };
    };
    const summaries = [filter, wrapped("/a"), wrapped("/b")];
    const usage = usageOf(summaries, [filter]);

    expect(usage.touches.map((one) => one.class)).toEqual(["wrapper"]);
    expect(usage.outcomes).toEqual([
      {
        kind: "responds",
        status: 302,
        conditions: filter.transitions[0]?.conditions,
      },
    ]);
    expect(usage.calls.map((one) => [one.kind, one.callee])).toEqual([
      ["wraps", "require_login"],
      ["wraps", "require_login"],
    ]);
    expect(usage.entryPoints.map((entry) => entry.boundary)).toEqual([
      "GET /a",
      "GET /b",
    ]);
  });
});

describe("constructUsage on a boundary", () => {
  it("lists each place a unit touches it, grouped by what the access selects by", () => {
    const { lookup } = store();
    const writer = unit({
      id: "Store.put",
      line: 20,
      effects: [
        {
          type: "interaction",
          binding: table,
          callee: "upsert",
          location: { start: 21, end: 21 },
          interaction: {
            class: "storage-access",
            kind: "write",
            fields: ["key", "value"],
          },
        },
      ],
    });
    const summaries = [lookup, writer];
    const usage = constructUsage(summaries, readCallFacts(summaries), {
      kind: "boundary",
      touches: touchesOfUnits(summaries),
    });

    expect(
      usage.groups.map((group) => [
        group.through,
        group.values[0]?.blanked,
        group.calls,
      ]),
    ).toEqual([
      ["reads", "key", 1],
      ["writes", null, 1],
    ]);
    expect(usage.callers.map((caller) => caller.owner)).toEqual(["Store"]);
  });
});

describe("constructUsage on the shapes a call can take", () => {
  const helper = unit({
    id: "lookupUser",
    file: "src/users.ts",
    line: 3,
    transitions: [
      {
        id: "lookupUser:1",
        conditions: [],
        output: { type: "return", value: null },
        effects: [
          {
            type: "interaction",
            binding: table,
            callee: "prisma.user.findUnique",
            interaction: {
              class: "storage-access",
              kind: "read",
              fields: ["*"],
              selector: ["id"],
            },
          },
        ],
        location: { start: 3, end: 6 },
        isDefault: true,
        provenance: [
          {
            at: { slot: "selector", effect: 0, name: "id" },
            from: [{ type: "input", inputRef: "id", path: [] }],
          },
        ],
      },
      {
        id: "lookupUser:2",
        conditions: [],
        output: {
          type: "response",
          statusCode: { type: "literal", value: 200 },
          body: null,
          headers: {},
        },
        effects: [],
        location: { start: 7, end: 7 },
        isDefault: false,
      },
    ],
    gaps: [
      {
        type: "unfollowedCall",
        conditions: [],
        consequence: "unknown",
        description: "an unfollowed call",
        callee: "audit",
      },
    ],
  });
  // A destructured parameter is two inputs at one position.
  helper.inputs = ["id", "include"].map((name) => ({
    type: "parameter" as const,
    name,
    position: 0,
    role: name,
    shape: null,
  }));
  const object = (id: RecordedArgument): RecordedArgument => ({
    kind: "object",
    fields: { id, include: { kind: "boolean", value: true } },
  });
  const both = route("GET", "/users/{id}", "src/userRoutes.ts", []);
  both.transitions = [1, 2].map((at) => ({
    id: `both:${at}`,
    conditions: [],
    output: { type: "return" as const, value: null },
    // The same call, listed on two paths, is one call.
    effects: [
      call(
        "lookupUser",
        helper,
        [object({ kind: "identifier", name: "req.params.id" })],
        4,
      ),
    ],
    location: { start: 2, end: 6 },
    isDefault: at === 1,
  }));
  const splat = route("POST", "/users", "src/createRoutes.ts", [
    call("lookupUser", helper, [{ kind: "identifier", name: "*args" }], 5),
  ]);
  const maybe = route("GET", "/maybe", "src/maybeRoutes.ts", [
    {
      type: "invocation",
      callee: "handlers[name]",
      possibleSummaries: [helper.identity.id as string, "missing::id"],
      args: [object({ kind: "string", value: "u1" })],
      async: false,
      location: { start: 4, end: 4 },
    },
  ]);
  const summaries = [helper, both, splat, maybe];
  const usage = usageOf(summaries, [helper]);

  it("reads a destructured parameter from the object the call passes, and counts a repeated call once", () => {
    expect(
      usage.groups.map((group) => [group.values[0]?.blanked, group.calls]),
    ).toEqual([
      [null, 1],
      ["_", 1],
      ['"u1"', 1],
    ]);
  });

  it("marks an entry point possible when the only call from it may run another function", () => {
    expect(usage.entryPoints).toEqual([
      expect.objectContaining({ boundary: "GET /users/{id}" }),
      expect.objectContaining({ boundary: "POST /users" }),
      expect.objectContaining({ boundary: "GET /maybe", possible: true }),
    ]);
  });

  it("lists the call the helper itself stops at", () => {
    expect(usage.gaps).toEqual([
      expect.objectContaining({ kind: "inside", callee: "audit" }),
    ]);
  });

  it("leaves a response under 300 out of the ways the helper fails", () => {
    expect(usage.outcomes).toEqual([]);
  });
});

describe("constructUsage on a helper that touches storage only through another", () => {
  it("says it touches storage through its helpers", () => {
    const { lookup } = store();
    const outer = unit({
      id: "Report.build",
      file: "app/report.rb",
      parameters: ["key"],
      effects: [
        call("lookup", lookup, [{ kind: "identifier", name: "key" }], 2),
      ],
    });
    const summaries = [lookup, outer];
    expect(usageOf(summaries, [outer]).touches).toEqual([
      {
        class: "storage-access",
        recognition: ["ruby-storage"],
        throughHelpers: true,
      },
    ]);
  });
});
