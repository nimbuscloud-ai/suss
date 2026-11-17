import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { fileMentions } from "./fileMentions.js";

describe("fileMentions", () => {
  it("says whether the file's text contains the word", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile(
      "src/a.ts",
      'import { setTimeout as wait } from "node:timers";\nwait(() => {}, 1);\n',
    );
    expect(fileMentions(sf, "node:timers")).toBe(true);
    expect(fileMentions(sf, "timers")).toBe(true);
    expect(fileMentions(sf, "setInterval")).toBe(false);
    expect(fileMentions(sf, "setInterval")).toBe(false);
  });

  it("answers from the new text once the file is parsed again", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const before = project.createSourceFile("src/a.ts", "run();\n", {
      overwrite: true,
    });
    expect(fileMentions(before, "timers")).toBe(false);
    const after = project.createSourceFile(
      "src/a.ts",
      'import { setTimeout } from "timers";\nsetTimeout(run, 1);\n',
      { overwrite: true },
    );
    expect(fileMentions(after, "timers")).toBe(true);
  });
});
