#!/usr/bin/env node
// Refuse to test against another checkout's build.
//
// A worktree without its own npm install resolves @suss/* through the
// primary checkout's node_modules, so its tests run against whatever
// dist that other tree last built. The result is a green run that
// says nothing about this tree, or a red one blaming it for someone
// else's state. Issue #132 has the history.
//
// Runs as pretest. Passing means every workspace package resolves to
// a path inside this checkout.

import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

let resolved;
try {
  resolved = require.resolve("@suss/ir-core");
} catch {
  // Not installed at all; npm's own error is clearer than ours.
  process.exit(0);
}

if (!resolved.startsWith(root + path.sep)) {
  process.stderr.write(
    `This checkout resolves @suss/ir-core from outside itself:\n  ${resolved}\nTests here would run against another tree's build. Run npm install in this checkout first.\n`,
  );
  process.exit(1);
}
