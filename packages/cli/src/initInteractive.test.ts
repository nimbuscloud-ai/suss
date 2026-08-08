// The prompts are stubbed and answered from a queue, so a test says
// "yes, no, yes" and asserts what reached the disk. What is not stubbed
// is the reading: these run against directories laid out on disk, so the
// questions asked are the ones a person would see in that project.

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

  /** Decline every question that would write or install. */
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

  it("says what it could not read, rather than reporting a project with nothing in it", async () => {
    // A legacy Python project whose setup.py computes its dependency
    // list has no pack to suggest and one thing worth saying. The
    // generic nothing-matched message on its own reads as though suss
    // had looked and found nothing there.
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
    expect(output()).toContain("suss extract -f hono -o summaries/code.json");
  });

  it("writes .sussignore only when asked for it", async () => {
    project(".", "api", ["hono"]);
    // install: no, sussignore: yes, ci: no. The first-run question is
    // skipped because nothing was installed.
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

      expect(output()).toContain("2 of its packages");
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
      expect(output()).toContain("Installed 2 packages");
    });

    it("stops at a failed install and leaves the command to retry", async () => {
      runResults.push({ code: 1, output: "npm ERR! 404 not found" });
      answers.push(true, false, false);

      await initInteractive({ dir });

      expect(output()).toContain("Install failed");
      expect(output()).toContain("npm ERR! 404 not found");
      expect(output()).toContain("Nothing else was changed");
      // Only the install was attempted; no extract followed it.
      expect(ran).toHaveLength(1);
    });

    it("reads the code and compares it when asked to", async () => {
      answers.push(true, true, false, false);

      await initInteractive({ dir });

      expect(ran[1]).toBe("npx suss extract -f hono -o summaries/code.json");
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
