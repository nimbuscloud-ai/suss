import { describe, expect, it } from "vitest";

import { effectsOverFile, packWithOnly } from "@suss/pack-harness";
import { runExamples } from "@suss/recognize";
import { createTestProject } from "@suss/test-project";

import nodeRuntimePack from "./index.js";
import { streamWriteRecognizers } from "./streamWrites.js";

import type { Effect } from "@suss/behavioral-ir";

type StreamWrite = Extract<Effect, { type: "interaction" }> & {
  interaction: { class: "stream-write" };
};

function writesIn(source: string): StreamWrite[] {
  const file = createTestProject().createSourceFile("cli.ts", source);
  return effectsOverFile(
    file,
    packWithOnly(nodeRuntimePack(), { invocation: streamWriteRecognizers }),
  ) as StreamWrite[];
}

function targetsOf(writes: StreamWrite[]): Array<string | null> {
  return writes.map((write) =>
    write.binding.semantics.name === "io"
      ? write.binding.semantics.target
      : "not io",
  );
}

describe("writes to the process's streams", () => {
  it("sends console output to the stream Node sends it to", () => {
    const writes = writesIn(`
      export function report(id: string) {
        console.log("order received", id);
        console.info("still going");
        console.error("failed");
        console.warn("careful");
      }
    `);
    expect(targetsOf(writes)).toEqual(["stdout", "stdout", "stderr", "stderr"]);
    expect(writes[0]?.callee).toBe("console.log");
  });

  it("reads a JSON report as the shape of what was serialized", () => {
    const [write] = writesIn(`
      export function print() {
        const report = { run: [{ kind: "nothingPaired" }] };
        process.stdout.write(\`\${JSON.stringify(report, null, 2)}\\n\`);
      }
    `);
    expect(write?.interaction.serialized).toBe("json");
    expect(write?.interaction.payload).toMatchObject({
      type: "record",
      properties: { run: { type: "array" } },
    });
    expect(write?.binding.semantics).toEqual({ name: "io", target: "stdout" });
  });

  it("keeps a text write as text, and keys each write on what it writes", () => {
    const source = `
      export function fail() {
        process.stderr.write("no summaries\\n");
        process.stderr.write("try again\\n");
      }
    `;
    const writes = writesIn(source);
    expect(writes.map((write) => write.interaction.serialized)).toEqual([
      "text",
      "text",
    ]);
    const ids = writes.map((write) => write.groupId);
    expect(ids[0]).toMatch(/^process\.stderr\.write:[0-9a-f]{7}$/);
    expect(new Set(ids).size).toBe(2);
    expect(writesIn(`\n\n\n${source}`).map((write) => write.groupId)).toEqual(
      ids,
    );
  });

  it("keys several arguments by position", () => {
    const [write] = writesIn(`
      export function say(id: number) {
        console.log("order", id);
      }
    `);
    expect(write?.interaction.payload).toEqual({
      type: "record",
      properties: {
        "0": { type: "literal", value: "order" },
        "1": { type: "number" },
      },
    });
  });

  it("follows a stream a caller passes into a helper", () => {
    const writes = writesIn(`
      function say(out: NodeJS.WritableStream, line: string) {
        out.write(line);
      }
      export function run() {
        say(process.stderr, "done");
      }
    `);
    expect(targetsOf(writes)).toEqual(["stderr"]);
  });

  it("writes to no stream in particular when two callers pass different ones", () => {
    const writes = writesIn(`
      function say(out, line: string) {
        out.write(line);
      }
      export function run() {
        say(process.stdout, "ok");
        say(process.stderr, "not ok");
      }
    `);
    expect(targetsOf(writes)).toEqual([null]);
  });

  it("takes an annotated stream parameter nobody calls as a write to an unknown stream", () => {
    const writes = writesIn(`
      export function say(out: NodeJS.WriteStream, line: string) {
        out.write(line);
      }
    `);
    expect(targetsOf(writes)).toEqual([null]);
  });

  it("leaves a write to anything else alone", () => {
    const writes = writesIn(`
      import * as fs from "node:fs";
      export function save(file: fs.WriteStream, logger: { info(m: string): void }) {
        file.write("row");
        logger.info("saved");
        [1].map((n) => n);
      }
    `);
    expect(writes).toEqual([]);
  });

  it("takes a Console parameter as a write to an unknown stream, since its streams are its own", () => {
    const writes = writesIn(`
      export function report(out: Console, id: string) {
        out.log("order", id);
        out.error("failed");
      }
    `);
    expect(targetsOf(writes)).toEqual([null, null]);
  });

  it("reads a console method called through optional chaining", () => {
    const writes = writesIn(`
      export function report() {
        console?.log("order received");
      }
    `);
    expect(targetsOf(writes)).toEqual(["stdout"]);
  });

  it("reads no console method on a name only a write stream reached", () => {
    const writes = writesIn(`
      function say(out, line: string) {
        out.log(line);
      }
      export function run() {
        say(process.stdout, "ok");
      }
    `);
    expect(writes).toEqual([]);
  });

  it("matches the line each declaration says it matches", () => {
    const ran = runExamples(nodeRuntimePack(), (code) =>
      writesIn(`export function example() { ${code}; }`),
    );
    expect(ran.map((one) => targetsOf(one.effects as StreamWrite[]))).toEqual([
      ["stderr"],
      ["stdout"],
    ]);
  });

  it("reads a method every object has as no write, even on console", () => {
    const writes = writesIn(`
      export function show() {
        return console.toString() + String(console.hasOwnProperty("log"));
      }
    `);
    expect(writes).toEqual([]);
  });
});
