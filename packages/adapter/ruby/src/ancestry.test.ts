import { describe, expect, it } from "vitest";

import { Database } from "@suss/datalog";

import { ancestryOf, methodInAncestry } from "./ancestry.js";
import {
  collectFileConstants,
  emitConstantBindings,
} from "./facts/constants.js";
import { emitValueFacts } from "./facts/values.js";
import { parseRuby } from "./parser.js";
import { walkDefinitions } from "./scope.js";
import { bindEvaluator, methodDefinitionsIn } from "./values/evaluator.js";

import type { MethodLookup, ReachedBody } from "./ancestry.js";
import type { RbNode } from "./parser.js";

/** What looking `name` up on the first class the source defines comes to, read without touching the disk. */
async function lookup(source: string, name: string): Promise<MethodLookup> {
  const tree = await parseRuby(source);
  const blocks: ReachedBody[] = [];
  const knownClasses = new Set<string>();
  walkDefinitions(tree.rootNode as unknown as RbNode, (info) => {
    knownClasses.add(info.qualifiedName);
    blocks.push({ info, knownClasses, file: "/app/models/subject.rb" });
  });
  const first = blocks[0];
  if (first === undefined) {
    throw new Error("the source defines no class");
  }
  const own = blocks.filter(
    (block) => block.info.qualifiedName === first.info.qualifiedName,
  );
  const ancestry = await ancestryOf(first.info.qualifiedName, own, {
    root: "/app/models",
    pathConvention: "railsUnderscore",
    ancestryRootClassNames: ["ActiveRecord::Base"],
    parsedFile: async () => null,
    localDefinition: (qualifiedName) => {
      const found = blocks.filter(
        (block) => block.info.qualifiedName === qualifiedName,
      );
      return found.length === 0 ? null : found;
    },
  });
  return methodInAncestry(ancestry, name);
}

const DYNAMIC = {
  type: "unsettled",
  cause: "dynamicDefine",
};

/**
 * The same lookup over a run of several files, with the value facts
 * emitted and bound the way a project run binds them, so a loop over a
 * list another file's method gives back is read here too.
 */
async function lookupInRun(
  files: Record<string, string>,
  className: string,
  name: string,
): Promise<MethodLookup> {
  const db = new Database();
  const parsed: { file: string; root: RbNode }[] = [];
  const definitions = new Map<string, RbNode>();
  const constants = [];
  for (const [file, source] of Object.entries(files)) {
    const root = (await parseRuby(source)).rootNode as unknown as RbNode;
    parsed.push({ file, root });
    emitValueFacts(db, file, root);
    for (const [key, method] of methodDefinitionsIn(file, root)) {
      definitions.set(key, method);
    }
    constants.push(collectFileConstants(file, root));
  }
  emitConstantBindings(db, constants);
  bindEvaluator(db, { files: parsed, definitions });

  const blocks: ReachedBody[] = [];
  const knownClasses = new Set<string>();
  for (const { file, root } of parsed) {
    walkDefinitions(root, (info) => {
      knownClasses.add(info.qualifiedName);
      blocks.push({ info, knownClasses, file });
    });
  }
  const ancestry = await ancestryOf(
    className,
    blocks.filter((block) => block.info.qualifiedName === className),
    {
      root: "/app",
      pathConvention: "railsUnderscore",
      ancestryRootClassNames: ["ActiveRecord::Base"],
      parsedFile: async () => null,
      localDefinition: (qualifiedName) => {
        const found = blocks.filter(
          (block) => block.info.qualifiedName === qualifiedName,
        );
        return found.length === 0 ? null : found;
      },
    },
  );
  return methodInAncestry(ancestry, name, { facts: db });
}

const BASE = `
class Base
  def expires_in(time)
    time
  end
end
`;

describe("a name a class defines with define_method", () => {
  it("reads a symbol written out", async () => {
    const source = `
class Subject
  define_method(:width) { 1 }
end
`;
    expect(await lookup(source, "width")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "height")).toEqual({ type: "none" });
  });

  it("reads a string written out", async () => {
    const source = `
class Subject
  define_method("width") { 1 }
end
`;
    expect(await lookup(source, "width")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "height")).toEqual({ type: "none" });
  });

  it("reads the elements of a literal array the enclosing each iterates", async () => {
    const source = `
class Subject
  %i(width height).each do |key|
    define_method(key) { 1 }
  end
end
`;
    expect(await lookup(source, "width")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "height")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "initialize")).toEqual({ type: "none" });
  });

  it("reads the elements of a constant the each is called on", async () => {
    const source = `
class Subject
  KEYS = %i(
    width
    height
  ).freeze

  KEYS.each do |key|
    define_method(key) { 1 }
  end
end
`;
    expect(await lookup(source, "width")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "initialize")).toEqual({ type: "none" });
  });

  it("reads the elements of a word array and of an array of symbols", async () => {
    const source = `
class Subject
  %w(width).each { |key| define_method(key) { 1 } }
  [:height].each_with_index { |key, i| define_method(key) { i } }
  [:depth].map { |key| define_method(key) { 1 } }
end
`;
    expect(await lookup(source, "width")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "height")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "depth")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "initialize")).toEqual({ type: "none" });
  });

  it("reads an interpolated symbol built from the element", async () => {
    const source = `
class Subject
  %i(width).each do |key|
    define_method(:"#{key}=") { |value| value }
  end
end
`;
    expect(await lookup(source, "width=")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "width")).toEqual({ type: "none" });
  });

  it("stops every lookup when one define_method has a name it could not read", async () => {
    const source = `
class Subject
  OTHER_KEYS.each do |key|
    define_method(key) { 1 }
  end
end
`;
    expect(await lookup(source, "width")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "initialize")).toMatchObject(DYNAMIC);
  });

  it("stops every lookup when a define_method is handed no name", async () => {
    const source = `
class Subject
  define_method() { 1 }
end
`;
    expect(await lookup(source, "width")).toMatchObject(DYNAMIC);
  });

  it("stops every lookup when one element of the array is not a literal", async () => {
    const source = `
class Subject
  [:width, OTHER_KEY].each { |key| define_method(key) { 1 } }
end
`;
    expect(await lookup(source, "width")).toMatchObject(DYNAMIC);
    expect(await lookup(source, "initialize")).toMatchObject(DYNAMIC);
  });

  it("stops every lookup when the block around the call is not a loop", async () => {
    const source = `
class Subject
  class_eval do
    define_method(key) { 1 }
  end
end
`;
    expect(await lookup(source, "width")).toMatchObject(DYNAMIC);
  });

  it("keeps a def of the same name, which the reader can follow", async () => {
    const source = `
class Subject
  %i(width).each { |key| define_method(key) { 1 } }

  def width
    2
  end
end
`;
    expect(await lookup(source, "width")).toMatchObject({ type: "found" });
  });

  it("carries on up the ancestry for a name none of them defines", async () => {
    const source = `
class Base
  def width
    1
  end
end

class Subject < Base
  %i(height).each { |key| define_method(key) { 1 } }
end
`;
    const tree = await parseRuby(source);
    const blocks: ReachedBody[] = [];
    const knownClasses = new Set<string>();
    walkDefinitions(tree.rootNode as unknown as RbNode, (info) => {
      knownClasses.add(info.qualifiedName);
      blocks.push({ info, knownClasses, file: "/app/models/subject.rb" });
    });
    const ancestry = await ancestryOf(
      "Subject",
      blocks.filter((block) => block.info.qualifiedName === "Subject"),
      {
        root: "/app/models",
        pathConvention: "railsUnderscore",
        ancestryRootClassNames: ["ActiveRecord::Base"],
        parsedFile: async () => null,
        localDefinition: (qualifiedName) => {
          const found = blocks.filter(
            (block) => block.info.qualifiedName === qualifiedName,
          );
          return found.length === 0 ? null : found;
        },
      },
    );
    expect(methodInAncestry(ancestry, "width")).toMatchObject({
      type: "found",
    });
    expect(methodInAncestry(ancestry, "height")).toMatchObject(DYNAMIC);
  });

  it("reads a loop over a list a project method gives back", async () => {
    const files = {
      "/app/base.rb": BASE,
      "/app/settings.rb": `
class Settings
  def self.filters
    %i[latest unread]
  end
end
`,
      "/app/subject.rb": `
class Subject < Base
  Settings.filters.each do |filter|
    define_method(filter) { 1 }
  end
end
`,
    };
    expect(await lookupInRun(files, "Subject", "latest")).toMatchObject(
      DYNAMIC,
    );
    expect(await lookupInRun(files, "Subject", "expires_in")).toMatchObject({
      type: "found",
    });
  });

  it("reads the memoised list a project method gives back", async () => {
    const files = {
      "/app/base.rb": BASE,
      "/app/settings.rb": `
class Settings
  def self.filters
    @filters ||= %i[latest unread]
  end

  def self.periods
    @@periods ||= %i[daily weekly].freeze
  end
end
`,
      "/app/subject.rb": `
class Subject < Base
  Settings.filters.each do |filter|
    define_method("category_#{filter}") { 1 }
  end

  Settings.periods.each do |period|
    define_method("top_#{period}") { 1 }
  end
end
`,
    };
    expect(
      await lookupInRun(files, "Subject", "category_latest"),
    ).toMatchObject(DYNAMIC);
    expect(await lookupInRun(files, "Subject", "top_daily")).toMatchObject(
      DYNAMIC,
    );
    expect(await lookupInRun(files, "Subject", "expires_in")).toMatchObject({
      type: "found",
    });
  });

  it("stops every lookup when the method gives back something else", async () => {
    const files = {
      "/app/base.rb": BASE,
      "/app/settings.rb": `
class Settings
  def self.filters
    load_filters
  end
end
`,
      "/app/subject.rb": `
class Subject < Base
  Settings.filters.each do |filter|
    define_method(filter) { 1 }
  end
end
`,
    };
    expect(await lookupInRun(files, "Subject", "expires_in")).toMatchObject(
      DYNAMIC,
    );
  });

  it("treats a name read only in part as a pattern the lookup has to match", async () => {
    const source = `
class Base
  def expires_in(time)
    time
  end
end

class Subject < Base
  OTHER_KEYS.each do |key|
    define_method("category_#{key}") { 1 }
  end
end
`;
    const files = { "/app/subject.rb": source };
    expect(
      await lookupInRun(files, "Subject", "category_latest"),
    ).toMatchObject(DYNAMIC);
    expect(await lookupInRun(files, "Subject", "expires_in")).toMatchObject({
      type: "found",
    });
  });

  it("stops at an ancestor this run never read, whatever the class defines", async () => {
    const source = `
class Subject
  include Concerns::Sized

  %i(width).each { |key| define_method(key) { 1 } }
end
`;
    expect(await lookup(source, "height")).toMatchObject({
      type: "unsettled",
      cause: "unreadAncestor",
    });
  });
});
