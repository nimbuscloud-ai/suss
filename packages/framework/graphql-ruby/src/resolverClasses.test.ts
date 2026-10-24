import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractRubyProject, findRubyFiles } from "@suss/adapter-ruby";
import { readWrapperMetadata } from "@suss/behavioral-ir";

import { graphqlRubyFramework } from "./index.js";

import type { RubyPack } from "@suss/adapter-ruby";
import type {
  BehavioralSummary,
  Effect,
  Transition,
} from "@suss/behavioral-ir";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const fixtureRoot = path.join(repoRoot, "fixtures", "ruby-graphql-resolvers");

/** The model calls these fixtures make, declared the way a storage pack would. */
const MODELS: RubyPack = {
  name: "models",
  protocol: "postgresql",
  discovery: [],
  storage: [
    {
      baseClasses: ["ActiveRecord::Base"],
      writes: ["update!", "create!"],
      reads: ["find", "where", "all", "count", "none?"],
      givesBack: ["find", "where", "all"],
      storageSystem: "postgresql",
    },
  ],
};

async function extractFixture(): Promise<BehavioralSummary[]> {
  const { summaries } = await extractRubyProject({
    files: findRubyFiles(fixtureRoot),
    packs: [
      graphqlRubyFramework({ root: path.join(fixtureRoot, "app", "graphql") }),
      MODELS,
    ],
    workspaceRoot: fixtureRoot,
  });
  return summaries;
}

function named(summaries: readonly BehavioralSummary[], name: string) {
  const summary = summaries.find((s) => s.identity.name === name);
  expect(summary, name).toBeDefined();
  return summary as BehavioralSummary;
}

/** The hook a transition came from, or undefined for the field's own. */
function hookOf(transition: Transition): string | undefined {
  return readWrapperMetadata(transition)?.from?.name;
}

/** The field's own outcome, without what its hooks add. */
function ownTransitions(summary: BehavioralSummary) {
  return summary.transitions.filter((t) => hookOf(t) === undefined);
}

function parameterNames(summary: BehavioralSummary): string[] {
  return summary.inputs.flatMap((input) =>
    input.type === "parameter" ? [input.name] : [],
  );
}

function storageWork(effects: readonly Effect[]): string[] {
  return effects.flatMap((effect) =>
    effect.type === "interaction" &&
    effect.interaction.class === "storage-access" &&
    effect.binding.semantics.name === "storage"
      ? [`${effect.interaction.kind} ${effect.binding.semantics.container}`]
      : [],
  );
}

function ownStorageWork(summary: BehavioralSummary): string[] {
  return ownTransitions(summary).flatMap((t) => storageWork(t.effects));
}

describe("a field wired to the class that resolves it", () => {
  it("reads the resolve method behind every wired root field", async () => {
    const summaries = await extractFixture();
    expect(ownStorageWork(named(summaries, "Mutation.approveTalk"))).toEqual([
      "read Talk",
      "write Talk",
    ]);
    expect(ownStorageWork(named(summaries, "Mutation.archiveEvent"))).toEqual([
      "read Event",
      "write Event",
    ]);
    expect(ownStorageWork(named(summaries, "Query.events"))).toEqual([
      "read Event",
      "read Event",
    ]);
  });

  it("finds a wired class the run read outside the configured root", async () => {
    const summaries = await extractFixture();
    const requestReview = named(summaries, "Mutation.requestReview");
    expect(requestReview.gaps).toEqual([]);
    expect(ownStorageWork(requestReview)).toEqual(["write Review"]);
  });

  it("reads a resolver: field on a type below the root", async () => {
    const summaries = await extractFixture();
    expect(ownStorageWork(named(summaries, "Talk.reviews"))).toEqual([
      "read Review",
    ]);
  });

  it("follows resolver_method: to the type's own method", async () => {
    const summaries = await extractFixture();
    const count = named(summaries, "Query.eventCount");
    expect(count.gaps).toEqual([]);
    expect(ownStorageWork(count)).toEqual(["read Event"]);
  });

  it("takes a mutation's inputs from its argument calls and its payload from its field calls", async () => {
    const summaries = await extractFixture();
    const approve = named(summaries, "Mutation.approveTalk");
    expect(parameterNames(approve)).toEqual(["id"]);
    expect(approve.metadata?.graphql).toMatchObject({
      declaredContract: {
        returnType: {
          type: "record",
          properties: {
            talk: { type: "ref", name: "Talk" },
            errors: { type: "array", items: { type: "text" } },
          },
        },
        args: [
          {
            name: "input",
            required: true,
            type: { type: "record", properties: { id: { type: "text" } } },
          },
        ],
      },
    });
  });

  it("wraps the arguments of a mutation that extends RelayClassicMutation directly", async () => {
    const summaries = await extractFixture();
    const archive = named(summaries, "Mutation.archiveEvent");
    expect(archive.metadata?.graphql).toMatchObject({
      declaredContract: {
        args: [
          {
            name: "input",
            type: {
              type: "record",
              properties: {
                eventId: { type: "text" },
                reason: { type: "union" },
                clientMutationId: { type: "union" },
              },
            },
          },
        ],
      },
    });
  });
});

describe("the hooks a wired class runs before resolve", () => {
  it("records each hook that runs as a wrapper, in the order the library runs them", async () => {
    const summaries = await extractFixture();
    const approve = named(summaries, "Mutation.approveTalk");
    expect(readWrapperMetadata(approve)?.applied).toEqual([
      {
        file: "app/graphql/concerns/requires_sign_in.rb",
        name: "ready?",
        line: 2,
      },
      {
        file: "app/graphql/mutations/approve_talk.rb",
        name: "authorized?",
        line: 7,
      },
    ]);
  });

  it("adds the error a ready? hook raises to the field it stops", async () => {
    const summaries = await extractFixture();
    const thrown = named(summaries, "Mutation.approveTalk").transitions.filter(
      (t) => t.output.type === "throw",
    );
    expect(thrown.map((t) => t.output)).toMatchObject([
      {
        type: "throw",
        exceptionType: "GraphQL::ExecutionError",
        message: "Sign in first",
      },
    ]);
    expect(thrown.map(hookOf)).toEqual(["ready?"]);
  });

  it("adds the early return of an authorized? hook that answers false, with the reads it made", async () => {
    const summaries = await extractFixture();
    const stopped = named(summaries, "Mutation.approveTalk").transitions.filter(
      (t) => hookOf(t) === "authorized?",
    );
    expect(stopped.map((t) => t.output.type)).toEqual(["return"]);
    expect(storageWork(stopped[0]?.effects ?? [])).toEqual(["read Talk"]);
  });

  it("follows super from one hook definition to the next one along the ancestry", async () => {
    const summaries = await extractFixture();
    const requestReview = named(summaries, "Mutation.requestReview");
    expect(readWrapperMetadata(requestReview)?.applied).toEqual([
      {
        file: "engines/reviews/app/graphql/mutations/request_review.rb",
        name: "ready?",
        line: 7,
      },
      {
        file: "app/graphql/concerns/requires_sign_in.rb",
        name: "ready?",
        line: 2,
      },
    ]);
    expect(
      requestReview.transitions.map((t) =>
        t.output.type === "throw" ? t.output.message : t.output.type,
      ),
    ).toEqual(["Reviews are closed", "Sign in first", "return"]);
  });

  it("gives each hook definition one summary of its own, however many fields share it", async () => {
    const summaries = await extractFixture();
    const hooks = summaries.filter((s) => s.kind === "middleware");
    expect(
      hooks.map((s) => `${s.location.file} ${s.identity.name}`).sort(),
    ).toEqual(
      [
        "app/graphql/concerns/requires_sign_in.rb ready?",
        "app/graphql/mutations/approve_talk.rb authorized?",
        "app/graphql/mutations/archive_event.rb ready?",
        "engines/reviews/app/graphql/mutations/request_review.rb ready?",
      ].sort(),
    );
  });

  it("leaves a hook path that lets the field go on off the field", async () => {
    const summaries = await extractFixture();
    const archive = named(summaries, "Mutation.archiveEvent");
    expect(archive.transitions.map((t) => t.output)).toEqual([
      {
        type: "return",
        value: { type: "record", properties: { event: { type: "null" } } },
      },
      {
        type: "return",
        value: {
          type: "record",
          properties: {
            event: {
              type: "union",
              variants: [{ type: "ref", name: "Event" }, { type: "null" }],
            },
          },
        },
      },
    ]);
  });

  it("records what a wired class's own type call declares, and the object type's fields", async () => {
    const summaries = await extractFixture();
    const events = named(summaries, "Query.events");
    expect(events.transitions.map((t) => t.output)).toEqual([
      {
        type: "return",
        value: {
          type: "array",
          items: {
            type: "ref",
            name: "Event",
            def: "Event",
            from: "app/graphql/types/event_type.rb",
          },
        },
      },
    ]);
    expect(events.definitions).toEqual({
      Event: {
        type: "record",
        properties: { id: { type: "text" }, name: { type: "text" } },
      },
    });
  });

  it("resolves the field to the payload an authorized? hook returns with its false", async () => {
    const summaries = await extractFixture();
    const hook = summaries.find(
      (s) => s.kind === "middleware" && s.identity.name === "authorized?",
    );
    expect(hook?.transitions[0]?.output).toEqual({
      type: "return",
      value: {
        type: "record",
        properties: {
          talk: { type: "null" },
          errors: {
            type: "array",
            items: { type: "literal", value: "Only the organizer can approve" },
          },
        },
      },
    });
  });
});
