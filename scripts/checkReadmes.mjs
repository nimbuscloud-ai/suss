#!/usr/bin/env node
/**
 * checkReadmes.mjs: what npm renders for a published package.
 *
 * A package page is where somebody who found suss through a search
 * lands, and several of ours had grown into a design document with no
 * link back to the project. A README says what the package is, links to
 * the repository and the documentation, and stays short enough to read;
 * the reference prose goes in DESIGN.md beside it, which is in the
 * repository and out of the published tarball.
 *
 * Usage: `node scripts/checkReadmes.mjs`
 */

import fs from "node:fs";
import path from "node:path";

import { findManifests } from "./workspacePackages.mjs";

/** Long enough for an example and a list, short enough to read. */
const MOST_LINES = 130;
const REPOSITORY = "https://github.com/nimbuscloud-ai/suss";

const problems = [];

for (const manifest of findManifests()) {
  const directory = path.dirname(manifest);
  const { name, private: isPrivate } = JSON.parse(
    fs.readFileSync(manifest, "utf8"),
  );
  if (isPrivate === true) {
    continue;
  }

  const readme = path.join(directory, "README.md");
  if (!fs.existsSync(readme)) {
    problems.push(`${name} publishes with no README, so its npm page is bare.`);
    continue;
  }

  const lines = fs.readFileSync(readme, "utf8").split("\n");
  if (!lines.some((line) => line.includes(REPOSITORY))) {
    problems.push(
      `${name}'s README never links to ${REPOSITORY}, so somebody who lands on the npm page cannot get to the project.`,
    );
  }

  if (lines.length > MOST_LINES) {
    problems.push(
      `${name}'s README is ${lines.length} lines, past ${MOST_LINES}. Move the reference half into DESIGN.md beside it and link to that.`,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `${problems.length} README problem(s):\n${problems
      .map((line) => `  ${line}\n`)
      .join("")}`,
  );
  process.exit(1);
}

process.stdout.write(
  "Every published package has a README that links back to the project and stays short.\n",
);
