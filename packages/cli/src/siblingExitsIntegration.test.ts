/**
 * A route that stops sending a player's golden count, while the CSV
 * export of the same table still sends it. Each language's fixture has
 * the same four routes: the stats route the change edits, the export
 * that reads the same column, a leaderboard that doesn't read it, and an
 * admin dump that reads every column without naming any.
 *
 * `inspect --diff` has to list the export, leave out the leaderboard,
 * and list the dump as not checked rather than as a sibling.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runCli } from "./run.js";

const repoRoot = path.resolve(__dirname, "../../..");

interface Case {
  readonly language: string;
  readonly fixture: string;
  readonly route: string;
  /** The stats route, spelled the way an ask question spells a unit. */
  readonly unit: string;
  readonly sent: string;
  readonly hidden: string;
  readonly extract: (code: string) => string[];
  readonly exporter: string;
  readonly dump: string;
}

const CASES: Case[] = [
  {
    language: "TypeScript",
    fixture: "sibling-exits-typescript",
    route: "src/players.ts",
    unit: "src/players.ts",
    sent: `res
    .status(200)
    .json({ name: player.name, games: player.games, golden: player.golden });`,
    hidden: "res.status(200).json({ name: player.name, games: player.games });",
    extract: (code) => [
      "-p",
      path.join(code, "tsconfig.json"),
      "-f",
      "express",
      "-f",
      "pg",
    ],
    exporter: "GET /players/export.csv",
    dump: "GET /admin/players",
  },
  {
    language: "Python",
    fixture: "sibling-exits-python",
    route: "app/players.py",
    unit: "player_stats",
    sent: 'return {"name": row.name, "games": row.games, "golden": row.golden}',
    hidden: 'return {"name": row.name, "games": row.games}',
    extract: (code) => [
      "--dir",
      code,
      "--lang",
      "python",
      "-f",
      "fastapi",
      "-f",
      `sqlalchemy=${path.join(code, "suss.sqlalchemy.json")}`,
    ],
    exporter: "GET /players/export.csv",
    dump: "GET /admin/players",
  },
  {
    language: "Ruby",
    fixture: "sibling-exits-ruby",
    route: "app/controllers/players_controller.rb",
    unit: "app/controllers/players_controller.rb",
    sent: "render json: { name: player.name, games: player.games, golden: player.golden }",
    hidden: "render json: { name: player.name, games: player.games }",
    extract: (code) => [
      "--dir",
      code,
      "--lang",
      "ruby",
      "-f",
      `rails=${path.join(code, "suss.rails.json")}`,
      "-f",
      `activerecord=${path.join(code, "suss.activerecord.json")}`,
    ],
    exporter: "GET /players/export",
    dump: "GET /admin/players",
  },
];

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Run the CLI and return what it printed, keeping it out of the test log. */
async function captured(
  argv: string[],
): Promise<{ code: number; out: string }> {
  let out = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await runCli(argv), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** A copy of the fixture the test can rewrite. */
function copied(one: Case): { root: string; code: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-sibling-exits-"));
  roots.push(root);
  const code = path.join(root, "code");
  fs.cpSync(path.join(repoRoot, "fixtures", one.fixture), code, {
    recursive: true,
  });
  return { root, code };
}

/** Extract the fixture as it is, then with the route hiding the count, and diff the two. */
async function diffOf(
  one: Case,
  json: boolean,
): Promise<{ code: number; out: string }> {
  const { root, code } = copied(one);
  const extractTo = async (out: string): Promise<void> => {
    const { code: exit } = await captured([
      "extract",
      ...one.extract(code),
      "--no-cache",
      "-o",
      out,
    ]);
    expect(exit).toBe(0);
  };

  await extractTo(path.join(root, "before.json"));
  const route = path.join(code, one.route);
  const source = fs.readFileSync(route, "utf-8");
  expect(source).toContain(one.sent);
  fs.writeFileSync(route, source.replace(one.sent, one.hidden));
  await extractTo(path.join(root, "after.json"));

  return captured([
    "inspect",
    "--diff",
    path.join(root, "before.json"),
    path.join(root, "after.json"),
    ...(json ? ["--json"] : []),
  ]);
}

interface SiblingJson {
  changed: { boundary: string | null };
  basis: string;
  data: Array<{ kind: string; at: string; field: string }>;
  siblings: Array<{
    boundary: string | null;
    shares: Array<{ field: string }>;
  }>;
  unchecked: Array<{ boundary: string | null; reasons: string[] }>;
}

describe.each(CASES)("a $language route that stops sending a field", (one) => {
  it("lists the export that still sends it, and the dump as not checked", async () => {
    const { code, out } = await diffOf(one, true);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { siblings: SiblingJson[] };

    expect(report.siblings).toHaveLength(1);
    const [group] = report.siblings;
    expect(group.basis).toBe("fields");
    expect(group.data.map((datum) => `${datum.kind} ${datum.field}`)).toEqual(
      expect.arrayContaining(["column golden", "sends golden"]),
    );
    expect(group.siblings.map((sibling) => sibling.boundary)).toEqual([
      one.exporter,
    ]);
    expect(group.siblings[0].shares.map((datum) => datum.field)).toEqual([
      "golden",
    ]);
    expect(group.unchecked.map((path) => path.boundary)).toEqual([one.dump]);
    expect(group.unchecked[0].reasons[0]).toContain("reads every column of");
  }, 60_000);

  it("prints the section under its heading", async () => {
    const { out } = await diffOf(one, false);

    expect(out).toContain(
      "Other paths that send the same data and did not change",
    );
    expect(out).toContain(`serves ${one.exporter}`);
    expect(out).not.toContain("serves GET /leaderboard");
  }, 60_000);

  it("answers the same lookup for the route as an ask question", async () => {
    const { root, code } = copied(one);
    const summaries = path.join(root, "summaries.json");
    const extracted = await captured([
      "extract",
      ...one.extract(code),
      "--no-cache",
      "-o",
      summaries,
    ]);
    expect(extracted.code).toBe(0);

    const { code: exit, out } = await captured([
      "ask",
      `what else sends the data ${one.unit} sends`,
      summaries,
      "--json",
    ]);
    expect(exit).toBe(0);
    const answer = JSON.parse(out) as {
      shape: string;
      items: Array<{ boundary?: string; unchecked?: string[] }>;
    };
    expect(answer.shape).toBe("sendsSame");
    const listed = answer.items
      .filter((item) => item.unchecked === undefined)
      .map((item) => item.boundary);
    expect(listed).toEqual(
      expect.arrayContaining([one.exporter, "GET /leaderboard"]),
    );
    expect(
      answer.items
        .filter((item) => item.unchecked !== undefined)
        .map((item) => item.boundary),
    ).toEqual([one.dump]);
  }, 60_000);
});
