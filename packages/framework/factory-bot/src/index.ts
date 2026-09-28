/**
 * Tells the Ruby adapter what a factory_bot build gives back, so a test
 * that writes `order = create(:order)` and then `order.cancel` reaches
 * `Order#cancel`. The class comes from the factory's definition: its
 * `class:`, the factory it gives as `parent:` or is nested in, or the
 * class its own name camelizes to.
 *
 * Every call listed here is one factory_bot defines. The README says
 * what the pack reads and what it leaves out.
 */

import { z } from "zod";

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

export const optionsSchema = z.object({}).strict();

export type FactoryBotPackOptions = z.infer<typeof optionsSchema>;

/** The build strategies that give back one record. */
const BUILDS = ["create", "build", "build_stubbed"];

/** The module a spec calls them on when it does not include factory_bot's syntax methods. */
const LIBRARY = "FactoryBot";

export function factoryBotFramework(
  _options: FactoryBotPackOptions = {},
): RubyPack {
  return {
    name: "factory-bot",
    protocol: "in-process",
    discovery: [],
    factories: [
      {
        definitionMethods: ["factory"],
        classKeywords: ["class"],
        parentKeywords: ["parent"],
        nestedDefinitionsInherit: true,
        builders: [
          ...BUILDS.map((method) => ({ method })),
          ...BUILDS.map((method) => ({ method, receiver: LIBRARY })),
        ],
      },
    ],
  };
}

/**
 * No dependency is listed, so `suss init` does not add this pack to a
 * project on its own. It says what a test builds, which only matters
 * alongside a test pack such as `rspec`.
 */
export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-factory-bot",
  dependencies: [],
  reads:
    "factory_bot builds in tests (Ruby), typed by the class each factory builds, so a test's calls on them are followed.",
};

export default factoryBotFramework;
