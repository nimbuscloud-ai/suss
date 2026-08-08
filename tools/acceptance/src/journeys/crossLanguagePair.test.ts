// A person has a TypeScript front end calling a Python service, and
// wants to know whether the two agree.
//
// This is the claim the language adapters were built for: a summary
// carries a boundary binding whatever language it came from, so the
// checker pairs a Python route against the TypeScript client that
// calls it without either side knowing about the other. Nothing below
// the CLI can show that, because the two extractions are two separate
// runs of the binary writing into one folder.

import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

describe("pair a TypeScript client against a Python provider", () => {
  const summaries = workspace("cross-language");

  beforeAll(() => {
    const provider = runSuss([
      "extract",
      "--dir",
      fixture("python-fastapi"),
      "-f",
      "fastapi",
      "-o",
      path.join(summaries, "shop.json"),
    ]);
    expect(provider.status, provider.stderr).toBe(0);

    const consumer = runSuss([
      "extract",
      "--dir",
      fixture("fetch"),
      "-f",
      "fetch",
      "-o",
      path.join(summaries, "web.json"),
    ]);
    expect(consumer.status, consumer.stderr).toBe(0);
  });

  it("pairs the two sides on the boundary they share", () => {
    const check = runSuss(["check", "--dir", summaries]);

    // GET /health is declared by a Python function and called by a
    // TypeScript one. Neither file mentions the other.
    expect(check.stdout).toContain("GET /health: health <-> getHealth");
  });

  it("says which routes have nobody on the other side", () => {
    const check = runSuss(["check", "--dir", summaries]);

    expect(check.stdout).toContain(
      "Providers with no client to compare against",
    );
    expect(check.stdout).toContain("POST /orders");
    expect(check.stdout).toContain(
      "Clients with no provider to compare against",
    );
    expect(check.stdout).toContain("GET /users/{id}");
  });

  it("reports the branch the client handles and the provider never sends", () => {
    const check = runSuss(["check", "--dir", summaries]);

    // The client branches on 503; the Python route declares 200 only.
    expect(check.stdout).toContain("deadConsumerBranch");
    expect(check.stdout).toContain(
      "Consumer expects status 503 but provider never produces it",
    );
    // Both sides of the finding are named, so a person knows where to
    // go: the Python file and the TypeScript one.
    expect(check.stdout).toContain("shop/main.py::health");
    expect(check.stdout).toContain("consumer.ts::getHealth");
  });

  it("exits zero, because nothing here is an error", () => {
    const check = runSuss(["check", "--dir", summaries]);

    expect(check.status).toBe(0);
    expect(check.stdout).toContain("0 error, 2 warning");
  });

  it("fails the run when the same findings are gated harder", () => {
    const check = runSuss([
      "check",
      "--dir",
      summaries,
      "--fail-on",
      "warning",
    ]);

    expect(check.status).toBe(1);
  });
});
