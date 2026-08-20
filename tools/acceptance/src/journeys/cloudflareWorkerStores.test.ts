import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace, writePackConfig } from "../harness.js";

/**
 * A Worker's KV, R2 and D1 calls against the bindings its
 * `wrangler.toml` declares. Pairing is name-to-name on the binding, so
 * a store the document binds pairs with the code that reads it, and a
 * binding the code reads without declaring comes back as an error.
 */
describe("check a Worker against the stores wrangler.toml binds", () => {
  const summaries = workspace("cloudflare-worker-stores");

  beforeAll(() => {
    // The pack config goes outside the summaries directory, since
    // `check --dir` reads every .json under it.
    const packConfig = writePackConfig(
      workspace("cloudflare-worker-stores-config"),
      "cloudflare-workers",
      { scriptName: "edge-cache" },
    );
    const code = runSuss([
      "extract",
      "--dir",
      fixture("cloudflare-worker-stores"),
      "-f",
      `cloudflare-workers=${packConfig}`,
      "-o",
      path.join(summaries, "code.json"),
    ]);
    expect(code.status, code.stderr).toBe(0);

    const infra = runSuss([
      "contract",
      "--from",
      "wrangler",
      path.join(fixture("cloudflare-worker-stores"), "wrangler.toml"),
      "-o",
      path.join(summaries, "infra.json"),
    ]);
    expect(infra.status, infra.stderr).toBe(0);
  });

  it("pairs each declared store against the calls that reach it", () => {
    const check = runSuss(["check", "--dir", summaries, "--all"]);

    expect(check.stdout).toContain(
      "cloudflare-kv:SESSIONS\n    wrangler:fixtures/cloudflare-worker-stores/wrangler.toml::kv_namespaces.SESSIONS <-> cloudflare-worker-stores::src/index.ts::fetch",
    );
    expect(check.stdout).toContain(
      "r2:ARCHIVE\n    wrangler:fixtures/cloudflare-worker-stores/wrangler.toml::r2_buckets.ARCHIVE <-> cloudflare-worker-stores::src/index.ts::fetch",
    );
    expect(check.stdout).toContain(
      "d1:LEDGER\n    wrangler:fixtures/cloudflare-worker-stores/wrangler.toml::d1_databases.LEDGER <-> cloudflare-worker-stores::src/index.ts::fetch",
    );
  });

  it("reports the binding the code reads and the document never declares", () => {
    const check = runSuss(["check", "--dir", summaries]);

    expect(check.status).toBe(1);
    expect(check.stdout).toContain(
      "env.AUDIT_KV read by fetch (worker/edge-cache scope) but edge-cache declares no AUDIT_KV in its environment.",
    );
  });
});
