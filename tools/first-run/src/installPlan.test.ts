import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { managerFor, planInstall } from "./installPlan.js";

const TOOLS = { bun: "/tools/bun", yarn: "/tools/yarn" };
const made: string[] = [];

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "first-run-"));
  made.push(root);
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }

  return root;
}

afterEach(() => {
  for (const root of made.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("managerFor", () => {
  it("picks the manager from the lockfile", () => {
    expect(managerFor(project({ "pnpm-lock.yaml": "" }))).toBe("pnpm");
    expect(managerFor(project({ "bun.lock": "" }))).toBe("bun");
    expect(managerFor(project({ "package-lock.json": "{}" }))).toBe("npm");
  });

  it("tells yarn 1 from a later yarn", () => {
    expect(managerFor(project({ "yarn.lock": "" }))).toBe("yarn");
    expect(
      managerFor(
        project({
          "yarn.lock": "",
          "package.json": '{"packageManager":"yarn@4.1.0"}',
        }),
      ),
    ).toBe("yarnBerry");
  });
});

describe("planInstall", () => {
  it("installs only at the root when the root has a lockfile", () => {
    const root = project({
      "pnpm-lock.yaml": "",
      "web/package-lock.json": "{}",
    });

    expect(planInstall(root, TOOLS).map((step) => step.dir)).toEqual([root]);
  });

  it("finds a client's lockfile below a root that has none, and turns scripts off", () => {
    const root = project({
      "pyproject.toml": "",
      "frontend/bun.lock": "",
      "docs/package-lock.json": "{}",
    });
    const steps = planInstall(root, TOOLS);

    expect(steps.map((step) => path.relative(root, step.dir))).toEqual([
      "frontend",
    ]);
    expect(steps[0]?.argv).toEqual([
      "/tools/bun",
      "install",
      "--ignore-scripts",
    ]);
  });
});
