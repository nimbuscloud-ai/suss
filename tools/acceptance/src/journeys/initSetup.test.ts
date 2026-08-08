// Piped, which is how it runs here and how it runs in CI, init prints the
// commands rather than asking.

import { describe, expect, it } from "vitest";

import { copyOfFixture, filesUnder, fixture, runSuss } from "../harness.js";

describe("set up a Python project", () => {
  const project = fixture("python-webapp");

  it("names both packs its requirements file asks for", () => {
    const init = runSuss(["init", project, "--plain"]);

    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain(
      "fastapi          fastapi in requirements.txt",
    );
    expect(init.stdout).toContain(
      "flask-restx      flask-restx in requirements.txt",
    );
  });

  it("gives a command that says the language outright", () => {
    const init = runSuss(["init", project, "--plain"]);

    expect(init.stdout).toContain("suss extract --lang python");
    expect(init.stdout).toContain("npm install --save-dev @suss/cli");
    expect(init.stdout).toContain("@suss/framework-fastapi");
    expect(init.stdout).toContain("@suss/framework-flask-restx");
  });

  it("says what each pack needs told before it will read anything", () => {
    const init = runSuss(["init", project, "--plain"]);

    expect(init.stdout).toContain("Write that to suss.flask-restx.json");
    expect(init.stdout).toContain('{"wrapperModules"');
  });
});

describe("set up a Ruby project", () => {
  const project = fixture("ruby-graphql");

  it("reads the lock file and names the pack", () => {
    const init = runSuss(["init", project, "--plain"]);

    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain("graphql-ruby     graphql in Gemfile.lock");
    expect(init.stdout).toContain("@suss/framework-graphql-ruby");
    expect(init.stdout).toContain("suss extract --lang ruby");
    expect(init.stdout).toContain('{"root":"app/graphql"}');
  });
});

describe("set up a project that declares a deploy template", () => {
  const project = fixture("aws-alb");

  it("offers to read the template as a contract", () => {
    const init = runSuss(["init", project, "--plain"]);

    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain(
      "cloudformation   a SAM template at template.yaml",
    );
    expect(init.stdout).toContain(
      "suss contract --from cloudformation template.yaml",
    );
  });
});

describe("set up a project whose language nothing declares", () => {
  const project = fixture("python-fastapi");

  it("says there is Python here that it could not match a pack to", () => {
    const init = runSuss(["init", project, "--plain"]);

    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain("matched a pack");
    expect(init.stdout).toContain(
      "There is Python code here and suss could not tell which packs read it",
    );
    expect(init.stdout).toContain("Name one yourself with -f");
  });
});

describe("init writes nothing on its own", () => {
  it("leaves the project exactly as it found it", () => {
    const project = copyOfFixture("python-webapp", "init-writes-nothing");
    const before = filesUnder(project);

    const init = runSuss(["init", ".", "--plain"], { cwd: project });

    expect(init.status, init.stderr).toBe(0);
    expect(filesUnder(project)).toEqual(before);
  });
});
