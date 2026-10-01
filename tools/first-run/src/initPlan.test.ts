import { describe, expect, it } from "vitest";

import { parseInitOutput, planCommands } from "./initPlan.js";

const MONOREPO_OUTPUT = `════ web ════

✓ Found 2 things to read in /work/app/web

1. Install suss

   npm install --save-dev @suss/cli

2. Read each side into one folder

   suss extract -f axios -f node -o summaries/code.json

3. Compare them

   suss check --dir summaries/

════ api ════

2. Read each side into one folder

   orders-orm reads nothing until you tell it which database is behind the engine.
   Write that to suss.orders-orm.json:
     {"storageSystem":"postgresql"}

   suss extract --lang python -f fastapi -f orders-orm=suss.orders-orm.json -o summaries/code.json
   suss contract --from openapi openapi.yaml -o summaries/openapi.json

3. Compare them

   suss check --dir summaries/
`;

describe("parseInitOutput", () => {
  it("reads one project per heading and keeps only the commands that read source", () => {
    const projects = parseInitOutput(MONOREPO_OUTPUT);

    expect(projects.map((project) => project.dir)).toEqual(["web", "api"]);
    expect(projects[0]?.commands).toEqual([
      ["extract", "-f", "axios", "-f", "node", "-o", "summaries/code.json"],
    ]);
    expect(projects[1]?.commands.map((argv) => argv[0])).toEqual([
      "extract",
      "contract",
    ]);
  });

  it("keeps the config init told the user to write", () => {
    const api = parseInitOutput(MONOREPO_OUTPUT)[1];

    expect(api?.configs).toEqual([
      {
        file: "suss.orders-orm.json",
        contents: '{"storageSystem":"postgresql"}',
      },
    ]);
    expect(api?.notes.length).toBeGreaterThan(0);
  });

  it("skips prose that starts with suss and keeps an unfinished command as a note", () => {
    const text = [
      "════ jobs ════",
      "  suss reads code through a pack per framework it recognizes.",
      "   suss extract -f fetch -f pg -f node ...",
    ].join("\n");
    const jobs = parseInitOutput(text)[0];

    expect(jobs?.commands).toEqual([]);
    expect(jobs?.notes).toEqual([
      "unfinished command: suss extract -f fetch -f pg -f node ...",
    ]);
  });

  it("treats output with no heading as one project at the root", () => {
    const projects = parseInitOutput(
      "2. Read\n\n   suss extract -f express -o summaries/code.json\n",
    );

    expect(projects).toHaveLength(1);
    expect(projects[0]?.dir).toBe(".");
  });
});

describe("planCommands", () => {
  it("runs each command in its project and sends every output to one folder", () => {
    const planned = planCommands(
      parseInitOutput(MONOREPO_OUTPUT),
      "/work/app",
      "/out",
    );

    expect(planned.map((command) => [command.cwd, command.output])).toEqual([
      ["/work/app/web", "/out/web--code.json"],
      ["/work/app/api", "/out/api--code.json"],
      ["/work/app/api", "/out/api--openapi.json"],
    ]);
    expect(planned[0]?.argv.at(-1)).toBe("/out/web--code.json");
  });

  it("runs a command from the root when init wrote its paths from there", () => {
    const planned = planCommands(
      parseInitOutput(`════ api ════

   suss extract --dir api --lang python -f fastapi -o summaries/api-code.json
   suss contract --from openapi api/openapi.yaml -o summaries/api-openapi.json
`),
      "/work/app",
      "/out",
    );

    expect(planned.map((command) => command.cwd)).toEqual([
      "/work/app",
      "/work/app",
    ]);
  });

  it("runs a contract from the root when its path is the project folder itself", () => {
    const planned = planCommands(
      parseInitOutput(`════ web ════

   suss contract --from graphql-documents web -o summaries/web-graphql-documents.json
`),
      "/work/app",
      "/out",
    );

    expect(planned.map((command) => command.cwd)).toEqual(["/work/app"]);
  });

  it("adds an output when init printed none", () => {
    const planned = planCommands(
      [
        {
          dir: ".",
          commands: [["extract", "-f", "express"]],
          notes: [],
          configs: [],
        },
      ],
      "/work/app",
      "/out",
    );

    expect(planned[0]?.argv).toEqual([
      "extract",
      "-f",
      "express",
      "-o",
      "/out/root--extract.json",
    ]);
  });
});
