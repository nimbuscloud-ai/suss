import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const answers: unknown[] = [];
/** What the next spawned command should pretend to have done. */
const runResults: Array<{ code: number; output: string }> = [];
const ran: string[] = [];
const cancelled = Symbol("cancel");
const shown: string[] = [];

function nextAnswer(fallback: unknown): unknown {
  return answers.length > 0 ? answers.shift() : fallback;
}

function record(text: unknown): void {
  shown.push(String(text));
}

vi.mock("./processRun.js", () => ({
  run: async (bin: string, args: string[]) => {
    ran.push([bin, ...args].join(" "));
    return runResults.shift() ?? { code: 0, output: "ok" };
  },
}));

vi.mock("@clack/prompts", () => ({
  isTTY: () => true,
  isCI: () => false,
  isCancel: (value: unknown) => value === cancelled,
  intro: record,
  outro: record,
  cancel: record,
  note: (body: unknown, title: unknown) =>
    record(`${String(title)}\n${String(body)}`),
  log: {
    info: record,
    warn: record,
    error: record,
    success: record,
    message: record,
  },
  confirm: async ({ initialValue }: { initialValue: boolean }) =>
    nextAnswer(initialValue),
  multiselect: async ({ initialValues }: { initialValues: string[] }) =>
    nextAnswer(initialValues),
  spinner: () => ({ start: record, stop: record }),
}));

const { initInteractive } = await import("./initInteractive.js");

describe("suss init, guided", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-init-"));
    answers.length = 0;
    shown.length = 0;
    runResults.length = 0;
    ran.length = 0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(relative: string, contents: string): void {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }

  function project(relative: string, name: string, deps: string[]): void {
    write(
      `${relative}/package.json`.replace(/^\//, ""),
      JSON.stringify({
        name,
        dependencies: Object.fromEntries(deps.map((d) => [d, "1.0.0"])),
      }),
    );
  }

  function output(): string {
    return shown.join("\n");
  }

  function declineEverything(count: number): void {
    answers.push(...Array<boolean>(count).fill(false));
  }

  it("says so plainly when nothing in the project names a pack", async () => {
    project(".", "empty", []);

    const code = await initInteractive({ dir });

    expect(code).toBe(0);
    expect(output()).toContain("Nothing in");
    expect(output()).toContain("No packs to suggest");
  });

  it("names the language it found when nothing in the project names a pack", async () => {
    write("app/main.py", "def handler():\n    return {}\n");

    const code = await initInteractive({ dir });

    expect(code).toBe(0);
    expect(output()).toContain(
      "There is Python code here and suss could not tell which packs read it",
    );
    expect(output()).toContain("Name one yourself with -f");
  });

  it("says what it could not read, rather than reporting a project with nothing in it", async () => {
    write("setup.py", "setup(install_requires=read_requirements())\n");

    const code = await initInteractive({ dir });

    expect(code).toBe(0);
    expect(output()).toContain("setup.py");
    expect(output()).toContain("computed");
  });

  it("still offers the packs it did find when another manifest is unreadable", async () => {
    project(".", "api", ["hono"]);
    write("setup.py", "setup(install_requires=read_requirements())\n");
    declineEverything(4);

    await initInteractive({ dir });

    expect(output()).toContain("hono");
    expect(output()).toContain("setup.py");
  });

  it("names each pack and what suggested it", async () => {
    project(".", "api", ["hono"]);
    declineEverything(4);

    await initInteractive({ dir });

    expect(output()).toContain("hono");
    expect(output()).toContain("Found");
  });

  it("leaves the install command behind when the install is declined", async () => {
    project(".", "api", ["hono"]);
    declineEverything(4);

    await initInteractive({ dir });

    expect(output()).toContain("npm install --save-dev @suss/cli");
    expect(output()).toContain("@suss/framework-hono");
  });

  it("shows the commands to run once the packs are there", async () => {
    project(".", "api", ["hono"]);
    declineEverything(4);

    await initInteractive({ dir });

    expect(output()).toContain("Once the packs are installed");
    expect(output()).toContain(
      "suss extract -f hono -f fetch -f node -o summaries/code.json",
    );
  });

  it("writes .sussignore only when asked for it", async () => {
    project(".", "api", ["hono"]);
    // install: no, sussignore: yes, ci: no. The first-run question is
    // skipped when nothing was installed.
    answers.push(false, true, false);

    await initInteractive({ dir });

    const file = path.join(dir, ".sussignore.json");
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.rules[0].reason).toBeTruthy();
  });

  it("does not ask about .sussignore when one is already there", async () => {
    project(".", "api", ["hono"]);
    fs.writeFileSync(path.join(dir, ".sussignore.json"), "{}");
    declineEverything(4);

    await initInteractive({ dir });

    expect(output()).not.toContain(".sussignore for findings");
    expect(fs.readFileSync(path.join(dir, ".sussignore.json"), "utf8")).toBe(
      "{}",
    );
  });

  it("writes down the artifacts a later run would otherwise miss", async () => {
    project(".", "api", ["hono"]);
    // install: no, sussignore: no, ci: no, project file: yes
    answers.push(false, false, false, true);

    await initInteractive({ dir });

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "suss.json"), "utf8"),
    ) as { read: Array<{ kind: string; packs?: string[] }> };
    expect(written.read.some((entry) => entry.kind === "extract")).toBe(true);
    expect(
      written.read.find((entry) => entry.kind === "extract")?.packs,
    ).toContain("hono");
  });

  it("writes the config each pack needs along with suss.json, and lists it there", async () => {
    write("Gemfile", 'source "https://rubygems.org"\ngem "rails"\n');
    write(
      "Gemfile.lock",
      "GEM\n  specs:\n    rails (7.1.0)\n    graphql (2.3.5)\n\nDEPENDENCIES\n  graphql\n  rails\n",
    );
    write("config/database.yml", "default: &default\n  adapter: mysql2\n");
    write(
      "app/controllers/application_controller.rb",
      "class ApplicationController < ActionController::Base\nend\n",
    );
    // install: no, sussignore: no, ci: no, project file: yes
    answers.push(false, false, false, true);

    await initInteractive({ dir });

    const written = JSON.parse(
      fs.readFileSync(path.join(dir, "suss.json"), "utf8"),
    ) as { read: Array<{ language?: string; packs?: string[] }> };
    const ruby = written.read.find((entry) => entry.language === "ruby");
    expect(ruby?.packs).toEqual(
      expect.arrayContaining([
        "rails=suss.rails.json",
        "graphql-ruby=suss.graphql-ruby.json",
        "activerecord=suss.activerecord.json",
      ]),
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(dir, "suss.activerecord.json"), "utf8"),
      ),
    ).toEqual({ storageSystem: "mysql" });
    expect(output()).toContain("Wrote suss.graphql-ruby.json");
  });

  it("leaves the project file alone when nobody asked for it", async () => {
    project(".", "api", ["hono"]);
    answers.push(false, false, false, false);

    await initInteractive({ dir });

    expect(fs.existsSync(path.join(dir, "suss.json"))).toBe(false);
  });

  it("writes a workflow that runs both halves and then compares them", async () => {
    project(".", "api", ["hono"]);
    // install: no, sussignore: no, ci: yes
    answers.push(false, false, true);

    await initInteractive({ dir });

    const workflow = fs.readFileSync(
      path.join(dir, ".github", "workflows", "suss.yml"),
      "utf8",
    );
    expect(workflow).toContain("on: pull_request");
    expect(workflow).toContain("suss extract -f hono");
    expect(workflow).toContain("suss check --dir summaries/");
  });

  it("leaves an existing workflow alone", async () => {
    project(".", "api", ["hono"]);
    write(".github/workflows/suss.yml", "name: mine\n");
    declineEverything(4);

    await initInteractive({ dir });

    expect(
      fs.readFileSync(path.join(dir, ".github/workflows/suss.yml"), "utf8"),
    ).toBe("name: mine\n");
  });

  describe("in a workspace", () => {
    beforeEach(() => {
      write(
        "package.json",
        JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      );
      project("packages/api", "@acme/api", ["hono"]);
      project("packages/web", "@acme/web", ["@apollo/client"]);
      project("packages/docs", "@acme/docs", []);
    });

    it("asks which packages to set up, leaving out the ones with nothing", async () => {
      answers.push(["packages/api", "packages/web"]);
      declineEverything(3);

      await initInteractive({ dir });

      expect(output()).toContain("2 of the projects here");
      expect(output()).toContain("packages/api");
      expect(output()).toContain("packages/web");
      expect(output()).not.toContain("packages/docs");
    });

    it("asks for one install covering every pack across the selection", async () => {
      answers.push(["packages/api", "packages/web"], false, false, false);

      await initInteractive({ dir });

      expect(output()).toContain("@suss/framework-hono");
      expect(output()).toContain("@suss/client-apollo");
    });

    it("keeps each package's summaries in its own file", async () => {
      answers.push(["packages/api", "packages/web"], false, false, false);

      await initInteractive({ dir });

      expect(output()).toContain("summaries/packages/api/code.json");
      expect(output()).toContain("summaries/packages/web/code.json");
    });

    it("acts only on the packages picked", async () => {
      answers.push(["packages/api"], false, false, false);

      await initInteractive({ dir });

      expect(output()).toContain("@suss/framework-hono");
      expect(output()).not.toContain("@suss/client-apollo");
    });

    it("changes nothing when the selection is emptied", async () => {
      answers.push([]);

      const code = await initInteractive({ dir });

      expect(code).toBe(0);
      expect(output()).toContain("Left everything as it was");
    });

    it("changes nothing when the selection is cancelled", async () => {
      answers.push(cancelled);

      await initInteractive({ dir });

      expect(output()).toContain("Left everything as it was");
    });
  });

  describe("when the install is accepted", () => {
    beforeEach(() => {
      project(".", "api", ["hono"]);
    });

    it("installs the CLI alongside every pack it suggested", async () => {
      // install: yes, first run: no, sussignore: no, ci: no
      answers.push(true, false, false, false);

      await initInteractive({ dir });

      expect(ran[0]).toContain("npm install --save-dev");
      expect(ran[0]).toContain("@suss/cli");
      expect(ran[0]).toContain("@suss/framework-hono");
      expect(output()).toContain("Installed 4 packages");
    });

    it("stops at a failed install and leaves the command to retry", async () => {
      runResults.push({ code: 1, output: "npm ERR! 404 not found" });
      answers.push(true, false, false);

      await initInteractive({ dir });

      expect(output()).toContain("Install failed");
      expect(output()).toContain("npm ERR! 404 not found");
      expect(output()).toContain("Nothing else was changed");
      expect(ran).toHaveLength(1);
    });

    it("reads the code and compares it when asked to", async () => {
      answers.push(true, true, false, false);

      await initInteractive({ dir });

      expect(ran[1]).toBe(
        "npx suss extract -f hono -f fetch -f node -o summaries/code.json",
      );
    });

    it("holds the commands back when the first run is declined", async () => {
      answers.push(true, false, false, false);

      await initInteractive({ dir });

      expect(ran).toHaveLength(1);
      expect(output()).toContain("When you are ready");
      expect(output()).toContain("suss extract -f hono");
    });

    it("stops and shows the output when a command crashes", async () => {
      runResults.push({ code: 0, output: "installed" });
      runResults.push({ code: 2, output: "Error: cannot find tsconfig" });
      answers.push(true, true, false, false);

      await initInteractive({ dir });

      expect(output()).toContain("failed");
      expect(output()).toContain("cannot find tsconfig");
    });

    it("reads a schema file through contract rather than extract", async () => {
      write(
        "template.yaml",
        "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n",
      );
      answers.push(true, true, false, false);

      await initInteractive({ dir });

      expect(ran.join("\n")).toContain(
        "npx suss contract --from cloudformation",
      );
    });
  });

  it("changes nothing when the install question is cancelled", async () => {
    project(".", "api", ["hono"]);
    answers.push(cancelled);

    const code = await initInteractive({ dir });

    expect(code).toBe(0);
    expect(output()).toContain("Left everything as it was");
    expect(fs.existsSync(path.join(dir, ".sussignore.json"))).toBe(false);
  });

  describe("with --write", () => {
    async function printedBy(run: () => Promise<number>): Promise<string> {
      const written: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          written.push(String(chunk));
          return true;
        });
      try {
        expect(await run()).toBe(0);
      } finally {
        spy.mockRestore();
      }
      return written.join("");
    }

    function projectFile(): { read: Array<Record<string, unknown>> } {
      return JSON.parse(fs.readFileSync(path.join(dir, "suss.json"), "utf8"));
    }

    it("prints the commands, then writes suss.json without asking", async () => {
      project(".", "api", ["hono"]);

      const text = await printedBy(() => initInteractive({ dir, write: true }));

      expect(text).toContain("suss extract -f hono");
      expect(text).toContain("Wrote suss.json");
      expect(shown).toEqual([]);
      expect(projectFile().read).toContainEqual(
        expect.objectContaining({
          kind: "extract",
          packs: expect.arrayContaining(["hono"]),
        }),
      );
    });

    it("leaves a suss.json that is already there alone, and says so", async () => {
      project(".", "api", ["hono"]);
      write("suss.json", '{ "version": 1, "read": [] }\n');

      const text = await printedBy(() => initInteractive({ dir, write: true }));

      expect(text).toContain("suss.json is already here");
      expect(text).toContain("--overwrite");
      expect(fs.readFileSync(path.join(dir, "suss.json"), "utf8")).toBe(
        '{ "version": 1, "read": [] }\n',
      );
    });

    it("replaces that suss.json when --overwrite asks it to", async () => {
      project(".", "api", ["hono"]);
      write("suss.json", '{ "version": 1, "read": [] }\n');

      await printedBy(() =>
        initInteractive({ dir, write: true, overwrite: true }),
      );

      expect(projectFile().read).toHaveLength(1);
    });

    it("writes nothing when nothing matched a pack", async () => {
      project(".", "empty", []);

      const text = await printedBy(() => initInteractive({ dir, write: true }));

      expect(text).toContain("init wrote nothing");
      expect(fs.existsSync(path.join(dir, "suss.json"))).toBe(false);
    });

    it("writes one suss.json for every package in a workspace, with each contract's path from the root", async () => {
      write(
        "package.json",
        JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      );
      project("packages/api", "@acme/api", ["hono"]);
      write("packages/api/openapi.yaml", "openapi: 3.0.0\npaths: {}\n");
      project("packages/web", "@acme/web", ["@apollo/client"]);

      await printedBy(() => initInteractive({ dir, write: true }));

      const read = projectFile().read;
      expect(read).toContainEqual({
        kind: "contract",
        from: "openapi",
        file: path.join("packages", "api", "openapi.yaml"),
      });
      const packs = read
        .filter((entry) => entry.kind === "extract")
        .map((entry) => entry.packs);
      expect(packs).toEqual([
        expect.arrayContaining(["hono"]),
        expect.arrayContaining(["apollo-client"]),
      ]);
    });
  });

  describe("without a terminal", () => {
    it("prints the commands instead of asking", async () => {
      project(".", "api", ["hono"]);
      const written: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          written.push(String(chunk));
          return true;
        });

      const code = await initInteractive({ dir, plain: true });
      spy.mockRestore();

      expect(code).toBe(0);
      expect(written.join("")).toContain("hono");
      expect(shown).toEqual([]);
    });

    it("labels each package when the workspace holds several", async () => {
      write(
        "package.json",
        JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      );
      project("packages/api", "@acme/api", ["hono"]);
      project("packages/web", "@acme/web", ["@apollo/client"]);

      const written: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          written.push(String(chunk));
          return true;
        });

      await initInteractive({ dir, plain: true });
      spy.mockRestore();

      const text = written.join("");
      expect(text).toContain("packages/api");
      expect(text).toContain("packages/web");
    });

    it("reads a Python service beside the npm workspace", async () => {
      write(
        "package.json",
        JSON.stringify({ name: "root", workspaces: ["frontend"] }),
      );
      write("pyproject.toml", '[tool.uv.workspace]\nmembers = ["backend"]\n');
      project("frontend", "frontend", ["axios"]);
      write(
        "backend/pyproject.toml",
        '[project]\nname = "app"\ndependencies = ["fastapi[standard]>=0.100", "sqlmodel"]\n',
      );
      write("backend/app/main.py", "from fastapi import FastAPI\n");

      const written: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          written.push(String(chunk));
          return true;
        });

      await initInteractive({ dir, plain: true });
      spy.mockRestore();

      const text = written.join("");
      expect(text).toContain("═ frontend ═");
      expect(text).toContain("═ backend ═");
      expect(text).toContain("fastapi in pyproject.toml");
      expect(text).not.toContain("could not tell which packs");
    });

    it("reads the Rails app at the root of a workspace that lists its frontend packages", async () => {
      write(
        "package.json",
        JSON.stringify({ name: "root", workspaces: ["frontend/*"] }),
      );
      project("frontend/web", "web", ["axios"]);
      write("Gemfile", 'source "https://rubygems.org"\ngem "railties"\n');
      write(
        "Gemfile.lock",
        "GEM\n  specs:\n    railties (8.0.0)\n\nDEPENDENCIES\n  railties\n",
      );
      write(
        "app/controllers/application_controller.rb",
        "class ApplicationController < ActionController::Base\nend\n",
      );

      const written: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          written.push(String(chunk));
          return true;
        });

      await initInteractive({ dir, plain: true });
      spy.mockRestore();

      const text = written.join("");
      expect(text).toContain("═ frontend/web ═");
      expect(text).toContain("═ . ═");
      expect(text).toContain("railties in Gemfile");
      expect(text).toContain("suss extract --lang ruby -f rails");
    });

    it("reads a Python service and a Ruby service under a root with no manifest", async () => {
      write(
        "api/pyproject.toml",
        '[project]\nname = "api"\ndependencies = ["flask-restx"]\n',
      );
      write("api/app.py", "from flask_restx import Api\n");
      write("web/Gemfile", 'source "https://rubygems.org"\ngem "rails"\n');
      write(
        "web/Gemfile.lock",
        "GEM\n  specs:\n    rails (7.1.0)\n\nDEPENDENCIES\n  rails\n",
      );
      write(
        "web/app/controllers/application_controller.rb",
        "class ApplicationController < ActionController::Base\nend\n",
      );

      const written: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          written.push(String(chunk));
          return true;
        });

      await initInteractive({ dir, plain: true });
      spy.mockRestore();

      const text = written.join("");
      expect(text).toContain("═ api ═");
      expect(text).toContain("═ web ═");
      expect(text).toContain("flask-restx in pyproject.toml");
      expect(text).toContain("rails in Gemfile");
      expect(text).not.toContain("could not tell which packs");
    });

    it("prints the empty report when nothing matched", async () => {
      project(".", "empty", []);
      const written: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          written.push(String(chunk));
          return true;
        });

      await initInteractive({ dir, plain: true });
      spy.mockRestore();

      expect(written.join("")).not.toBe("");
    });
  });
});
