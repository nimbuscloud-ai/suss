// A person points suss at something it cannot read.
//
// Every case here is a mistake somebody makes on their first afternoon
// with the tool: an empty directory, a pack name that does not exist,
// a JSON file that is not summaries, a folder of summaries with one
// stray file in it. What they should get back is a sentence saying
// what went wrong and what to type instead.
//
// A stack trace is the failure this file exists to catch. The message
// under it is usually already a good sentence, written by whoever
// threw it, and printing eight frames of bundled `dist/bin.js` on top
// buries it and tells a person their input broke the tool rather than
// that they mistyped something.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixture, runSuss, workspace } from "../harness.js";

/** What a stack trace looks like in output, wherever it came from. */
const STACK_FRAME = /\n\s+at .+:\d+:\d+/;

describe("point suss at something it cannot read", () => {
  it("says it could not tell the language of an empty directory", () => {
    const empty = workspace("empty");

    const extract = runSuss(["extract", "--dir", empty, "-f", "express"]);

    expect(extract.status).toBe(1);
    expect(extract.stderr).toContain("could not tell what language");
    expect(extract.stderr).toContain("Pass --lang to say which it is");
    expect(extract.stderr).not.toMatch(STACK_FRAME);
  });

  it("says which directory it looked in when there is none", () => {
    const missing = path.join(workspace("missing"), "nope");

    const extract = runSuss(["extract", "--dir", missing, "-f", "express"]);

    expect(extract.status).toBe(1);
    expect(extract.stderr).toContain(`No directory at ${missing}`);
    expect(extract.stderr).not.toMatch(STACK_FRAME);
  });

  it("lists the packs it has when the one named does not exist", () => {
    const extract = runSuss([
      "extract",
      "--dir",
      fixture("express"),
      "-f",
      "nosuchpack",
    ]);

    expect(extract.status).toBe(1);
    expect(extract.output).toContain('Unknown pack: "nosuchpack"');
    expect(extract.output).toContain("@suss/framework-nosuchpack");
    expect(extract.output).toContain("Built in:");
    expect(extract.output).not.toMatch(STACK_FRAME);
  });

  it("says a file is not summaries rather than throwing at the parser", () => {
    const dir = workspace("not-summaries");
    const file = path.join(dir, "notes.json");
    fs.writeFileSync(file, JSON.stringify({ hello: 1 }));

    const inspect = runSuss(["inspect", file]);

    expect(inspect.status).toBe(1);
    expect(inspect.output).toContain("Invalid summary file");
    expect(inspect.output).toContain("expected array, received object");
    expect(inspect.output).not.toMatch(STACK_FRAME);
  });

  it("names the stray file when a summaries folder holds one", () => {
    const dir = workspace("stray-file");
    fs.writeFileSync(
      path.join(dir, "notes.json"),
      JSON.stringify({ hello: 1 }),
    );

    const check = runSuss(["check", "--dir", dir]);

    expect(check.status).toBe(1);
    expect(check.output).toContain("could not read");
    expect(check.output).toContain("notes.json");
    expect(check.output).toContain(
      "It should be the output of `suss extract` or `suss contract`",
    );
    expect(check.output).not.toMatch(STACK_FRAME);
  });

  it("says a summaries file is missing rather than which line threw", () => {
    const missing = path.join(workspace("no-file"), "gone.json");

    const check = runSuss(["check", missing, missing]);

    expect(check.status).toBe(1);
    expect(check.output).toContain(`No file at ${missing}`);
    expect(check.output).not.toMatch(STACK_FRAME);
  });

  it("names the command that does not exist, and lists the ones that do", () => {
    const run = runSuss(["explain"]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('There is no "explain" command');
    expect(run.stderr).toContain("suss has init, extract, inspect, check");
  });

  it("never exits zero with nothing to show for it", () => {
    const empty = workspace("silence");

    const extract = runSuss(["extract", "--dir", empty, "-f", "express"]);

    // Silence and a zero exit is the other half of the failure this
    // file guards: a CI job cannot tell it apart from a passing run.
    expect(extract.status).not.toBe(0);
    expect(extract.output.trim()).not.toBe("");
  });
});
