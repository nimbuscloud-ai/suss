import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkoutOf, rootAsSpelledBy } from "./checkout.js";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A folder holding a repository at `repo` with one file committed, and room beside it. */
function repository(): { parent: string; repo: string } {
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-checkout-")),
  );
  made.push(parent);
  const repo = path.join(parent, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "a",
  );
  return { parent, repo };
}

describe("checkoutOf", () => {
  it("finds the checkout's root, its repository and the main checkout", () => {
    const { repo } = repository();

    expect(checkoutOf(path.join(repo, "src"))).toEqual({
      root: repo,
      commonDir: path.join(repo, ".git"),
      main: repo,
    });
  });

  it("finds no checkout outside git", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "suss-no-git-"));
    made.push(outside);

    expect(checkoutOf(outside)).toBeNull();
  });
});

describe("rootAsSpelledBy", () => {
  it("spells the root the way a path through a symlink does", () => {
    const { parent, repo } = repository();
    const link = path.join(parent, "link");
    fs.symlinkSync(repo, link);
    const checkout = checkoutOf(repo);

    expect(checkout).not.toBeNull();
    expect(
      checkout && rootAsSpelledBy(checkout, path.join(link, "src", "a.ts")),
    ).toBe(link);
    expect(
      checkout && rootAsSpelledBy(checkout, path.join(repo, "src", "a.ts")),
    ).toBe(repo);
  });

  it("has no spelling for a file outside the checkout, or a link to one file in it", () => {
    const { parent, repo } = repository();
    const outside = path.join(parent, "outside.ts");
    fs.writeFileSync(outside, "");
    const fileLink = path.join(parent, "a-link.ts");
    fs.symlinkSync(path.join(repo, "src", "a.ts"), fileLink);
    const checkout = checkoutOf(repo);

    expect(checkout).not.toBeNull();
    if (checkout === null) {
      return;
    }
    expect(rootAsSpelledBy(checkout, outside)).toBeNull();
    expect(rootAsSpelledBy(checkout, path.join(parent, "gone.ts"))).toBeNull();
    expect(rootAsSpelledBy(checkout, fileLink)).toBeNull();
  });
});
