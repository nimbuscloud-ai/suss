import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assembleBaseline,
  readBaselineFromTree,
  writeBaseline,
} from "./dogfoodBaseline.mjs";

const PACKAGES = {
  "packages/values": {
    name: "@suss/values",
    exports: 53,
    internal: 79,
    consumers: 4,
    unfollowedCalls: 27,
  },
  "packages/adapter/ruby": {
    name: "@suss/adapter-ruby",
    exports: 75,
    internal: 762,
    consumers: 299,
    unfollowedCalls: 107,
  },
  "packages/types-only": {
    name: "@suss/types-only",
    exports: 0,
    internal: 2,
    consumers: 1,
    unfollowedCalls: 0,
  },
};

const SHARED = { pairs: 1649, findingErrors: 0 };

/** A repo root with a package.json in each package directory. */
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dogfoodBaseline-"));
  for (const dir of Object.keys(PACKAGES)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "package.json"), "{}\n");
  }
  fs.mkdirSync(path.join(root, "scripts"));
  return root;
}

test("the totals are the sums of the package counts", () => {
  const { totals } = assembleBaseline({ packages: PACKAGES, shared: SHARED });
  assert.deepEqual(totals, {
    packages: 3,
    packagesWithExports: 2,
    exports: 128,
    internal: 843,
    consumers: 304,
    pairs: 1649,
    unfollowedCalls: 134,
    findingErrors: 0,
  });
});

test("the packages come back in name order, keyed by directory", () => {
  const { packages } = assembleBaseline({ packages: PACKAGES, shared: SHARED });
  assert.deepEqual(Object.keys(packages), [
    "packages/adapter/ruby",
    "packages/types-only",
    "packages/values",
  ]);
});

test("a count the shared file does not have is left out of the totals", () => {
  const { totals } = assembleBaseline({
    packages: PACKAGES,
    shared: { pairs: 7 },
  });
  assert.equal(totals.pairs, 7);
  assert.equal("findingErrors" in totals, false);
});

test("what a dogfood run writes reads back as the same baseline", () => {
  const root = makeRoot();
  writeBaseline({ root, packages: PACKAGES, shared: SHARED });
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(root, "packages/values/dogfood-baseline.json")),
    ),
    PACKAGES["packages/values"],
  );
  assert.deepEqual(
    readBaselineFromTree(root),
    assembleBaseline({ packages: PACKAGES, shared: SHARED }),
  );
});

test("a package with no baseline file adds nothing to the totals", () => {
  const root = makeRoot();
  writeBaseline({ root, packages: PACKAGES, shared: SHARED });
  fs.rmSync(path.join(root, "packages/types-only/dogfood-baseline.json"));
  const { totals, packages } = readBaselineFromTree(root);
  assert.equal(totals.packages, 2);
  assert.equal(packages["packages/types-only"], undefined);
});
