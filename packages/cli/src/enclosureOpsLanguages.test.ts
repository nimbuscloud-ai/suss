/**
 * The ops that say what a call or a function is written inside, asked of
 * the same code written in TypeScript, Python and Ruby: the call a
 * function is passed to, and the body a call or a function is written in.
 * A test runner's cases are found by walking up through them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bindModule,
  parsePython,
  factsForFile as pythonFactsForFile,
  pythonModuleOps,
} from "@suss/adapter-python";
import { moduleOpsForFile, preloadRubyGrammar } from "@suss/adapter-ruby";
import { moduleOpsFor, ResolutionStore } from "@suss/adapter-typescript";
import { createTestProject } from "@suss/test-project";

import type { CallOps, ModuleOps, ValueOps } from "@suss/extractor";

const TYPESCRIPT = `
import { other } from "./other";

group("orders", () => {
  check("cancels", () => cancel(1));
  function helper() {
    check("inside", () => cancel(2));
  }
});
setup(cancel(3));
const local = 1;
other.it.skip("later");
`;

const PYTHON = `
from other import other

def orders():
    check("cancels", lambda: cancel(1))

    def helper():
        check("inside", lambda: cancel(2))

setup(cancel(3))
other.it.skip("later")
`;

const RUBY = `
group "orders" do
  check "cancels" do
    cancel 1
  end
  check "inside", -> { cancel 2 }
end
setup(cancel(3))
other = 1
other.it.skip("later")
`;

let root: string;

beforeAll(async () => {
  await preloadRubyGrammar();
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-enclosure-ops-")),
  );
  fs.writeFileSync(path.join(root, "app.rb"), RUBY);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function typescriptModule(): ModuleOps {
  const project = createTestProject();
  project.createSourceFile("/other.ts", "export const other = 1;\n");
  const file = project.createSourceFile("/app.ts", TYPESCRIPT);
  return moduleOpsFor(file, ResolutionStore.forPacks([]));
}

async function pythonModule(): Promise<ModuleOps> {
  const file = path.join(root, "app.py");
  const tree = await parsePython(PYTHON);
  const module = bindModule(tree.rootNode);
  const db = pythonFactsForFile({
    file,
    root: tree.rootNode,
    module,
    packs: [],
  });
  return pythonModuleOps(
    { file, displayPath: "app.py", root: tree.rootNode, module },
    db,
  );
}

function rubyModule(): ModuleOps {
  return moduleOpsForFile(path.join(root, "app.rb"));
}

/** The calls the file writes to the callee, in source order. */
function callsTo(module: ModuleOps, callee: string): CallOps[] {
  return module.calls("file").filter((call) => call.calleeText() === callee);
}

/** The function the call passes at `at`, or its block when it passes none there. */
function handed(call: CallOps | undefined, at: number): ValueOps | null {
  return call?.valueAt(at)?.function?.() ?? call?.block?.() ?? null;
}

/** The key the value or call is at, which the test expects the ops to give. */
function site(value: ValueOps | CallOps | null | undefined): string {
  const key = value?.site?.();
  expect(key).toBeDefined();
  return key as string;
}

describe("the ops over what code is written inside, asked of three languages", () => {
  it("give the call a function written in place is passed to, and where", async () => {
    for (const module of [
      typescriptModule(),
      await pythonModule(),
      rubyModule(),
    ]) {
      const inside = callsTo(module, "check")[1];
      const passed = handed(inside, 1)?.passedTo?.();
      expect(site(passed?.call)).toBe(site(inside));
      expect(passed?.at).toBe(1);
    }
  });

  it("give a call the innermost function or block it is written in, and none at the top of a file", async () => {
    for (const module of [
      typescriptModule(),
      await pythonModule(),
      rubyModule(),
    ]) {
      const [cancels] = callsTo(module, "check");
      const [first, , top] = callsTo(module, "cancel");
      expect(site(first?.enclosingBody?.())).toBe(site(handed(cancels, 1)));
      expect(top?.enclosingBody?.()).toBeNull();
    }
  });

  it("give a function the body it is written in: its call's, when it is passed in place or is a block", async () => {
    const python = await pythonModule();
    const orders = python.export(["orders"]);
    const [pythonCancels] = callsTo(python, "check");
    expect(site(handed(pythonCancels, 1)?.enclosingBody?.())).toBe(
      site(orders),
    );

    for (const module of [typescriptModule(), rubyModule()]) {
      const [group] = callsTo(module, "group");
      const [cancels, inside] = callsTo(module, "check");
      const groupBody = site(handed(group, 1));
      expect(site(handed(cancels, 1)?.enclosingBody?.())).toBe(groupBody);
      expect(site(handed(inside, 1)?.enclosingBody?.())).toBe(
        site(inside?.enclosingBody?.()),
      );
      expect(handed(group, 1)?.enclosingBody?.()).toBeNull();
    }
  });

  it("read a callee's member reads back to the name it starts from", async () => {
    for (const module of [
      typescriptModule(),
      await pythonModule(),
      rubyModule(),
    ]) {
      const [skip] = module.calls("file").filter((c) => c.method() === "skip");
      expect(skip?.receiverValue?.()?.form?.()).not.toBe("name");
      const member = skip?.member?.() ?? null;
      expect(member?.method()).toBe("it");
      const root = member?.receiverValue?.() ?? null;
      expect(root?.form?.()).toBe("name");
      expect(root?.source?.()).toBe("other");
    }
  });

  it("say what a TypeScript file binds at its top level", () => {
    const module = typescriptModule();
    expect(module.bindsAtTopLevel?.("other")).toBe(true);
    expect(module.bindsAtTopLevel?.("local")).toBe(true);
    expect(module.bindsAtTopLevel?.("check")).toBe(false);
  });
});
