/**
 * `what calls` and `what can I project from` on routes that share words,
 * one app per language. Each app serves `POST /notes`, a route under it,
 * a route around it, and a route whose path is the start of another, and
 * calls each one with its parameter spelled differently from the route.
 * Each app is read with `extract`, and every answer comes from the
 * summaries written to disk, so `ask` reads what `check` reads.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { originalIdOf, summaryIdentifier } from "@suss/behavioral-ir";
import { boundarySpelling, checkAll } from "@suss/checker";

import { answerQuestion } from "./ask.js";
import { extract } from "./extract.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { AnswerJson } from "./ask.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);

let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "suss-route-callers-"));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function asked(question: string, dir: string): AnswerJson {
  const { answer } = answerQuestion({
    question,
    dir,
    json: true,
    output: path.join(scratch, "answer.json"),
  });
  expect(answer?.found, `${question}: ${answer?.headline}`).toBe(true);
  return answer as AnswerJson;
}

function unitsIn(answer: AnswerJson): string[] {
  return (answer.items as Array<{ unit: string }>)
    .map((item) => item.unit)
    .sort();
}

/** Each route `check` pairs a client with, and the clients it pairs there. */
function pairedByCheck(
  summaries: BehavioralSummary[],
): Map<string, Set<string>> {
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );
  const routes = new Map<string, Set<string>>();
  for (const pair of checkAll(summaries).pairs) {
    const provider = byId.get(pair.provider);
    const consumer = byId.get(pair.consumer);
    const binding = provider?.identity.boundaryBinding;
    if (binding === null || binding === undefined || consumer === undefined) {
      continue;
    }
    const route = boundarySpelling(binding);
    const clients = routes.get(route) ?? new Set();
    clients.add(originalIdOf(consumer));
    routes.set(route, clients);
  }
  return routes;
}

function unitEnding(summaries: BehavioralSummary[], ending: string): string {
  const found = summaries.find((summary) =>
    originalIdOf(summary).endsWith(ending),
  );
  expect(found, ending).toBeDefined();
  return originalIdOf(found as BehavioralSummary);
}

/** Writes a Rails pack config with absolute paths, since a relative one is read against the config file. */
function railsConfig(): string {
  const app = path.join(fixtures, "route-callers-ruby");
  const config = path.join(scratch, "rails.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      root: path.join(app, "app"),
      routesFile: path.join(app, "config/routes.rb"),
    }),
  );
  return config;
}

const APPS: ReadonlyArray<{
  language: string;
  read: (output: string) => Promise<BehavioralSummary[]>;
  create: string;
  show: string;
}> = [
  {
    language: "TypeScript",
    read: (output) =>
      extract({
        tsconfig: path.join(fixtures, "route-callers-typescript/tsconfig.json"),
        frameworks: ["express", "fetch"],
        output,
        noCache: true,
        quiet: true,
      }),
    create: "client.ts::createNote",
    show: "server.ts::get#GET /notes/{id}",
  },
  {
    language: "Python",
    read: (output) =>
      extract({
        dir: path.join(fixtures, "route-callers-python"),
        lang: "python",
        frameworks: ["fastapi", "httpx"],
        output,
        noCache: true,
        quiet: true,
      }),
    create: "client.py::create_note",
    show: "main.py::read_note",
  },
  {
    language: "Ruby",
    read: (output) =>
      extract({
        dir: path.join(fixtures, "route-callers-ruby"),
        lang: "ruby",
        frameworks: [`rails=${railsConfig()}`, "net-http"],
        output,
        noCache: true,
        quiet: true,
      }),
    create: "notes_client.rb::create_note",
    show: "notes_controller.rb::NotesController.show",
  },
];

describe.each(APPS)("routes that share words, in $language", (app) => {
  let summaries: BehavioralSummary[];
  let dir: string;

  beforeAll(async () => {
    dir = path.join(scratch, app.language);
    fs.mkdirSync(dir, { recursive: true });
    summaries = await app.read(path.join(dir, "code.json"));
  }, 120_000);

  it("lists under what calls every client check pairs with the route", () => {
    const routes = pairedByCheck(summaries);
    expect(routes.size).toBe(4);
    for (const [route, clients] of routes) {
      const listed = unitsIn(asked(`what calls ${route}`, dir));
      for (const client of clients) {
        expect(listed, route).toContain(client);
      }
    }
  });

  it("leaves out the clients of routes that only share the words", () => {
    expect(unitsIn(asked("what calls POST /notes", dir))).toEqual([
      unitEnding(summaries, app.create),
    ]);
  });

  it("finds the client that spells the route's parameter its own way", () => {
    const listed = unitsIn(asked("what calls POST /notes/{id}/archive", dir));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatch(/archive_?[nN]ote$/);
  });

  it("declares what the one route returns, without the route under it", () => {
    const from = (
      asked("what can I project from GET /notes/{id}", dir).items as Array<{
        from: string;
      }>
    ).map((item) => item.from);
    expect(from.length).toBeGreaterThan(0);
    expect(new Set(from)).toEqual(
      new Set(
        summaries
          .filter((summary) => originalIdOf(summary).endsWith(app.show))
          .map(summaryIdentifier),
      ),
    );
  });
});
