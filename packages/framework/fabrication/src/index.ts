/**
 * Tells the Ruby adapter what a Fabrication build gives back, so a test
 * that writes `status = Fabricate(:status)` and then `status.reblog?`
 * reaches `Status#reblog?`. The class comes from the fabricator's
 * definition: its `class_name:`, the fabricator or class it gives as
 * `from:`, or the class its own name camelizes to.
 *
 * Every call listed here is one Fabrication defines. The README says
 * what the pack reads and what it leaves out.
 */

import { z } from "zod";

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

export const optionsSchema = z.object({}).strict();

export type FabricationPackOptions = z.infer<typeof optionsSchema>;

/** The constant `Fabricate.build(:x)` and `Fabricate.create(:x)` are called on. */
const LIBRARY = "Fabricate";

export function fabricationFramework(
  _options: FabricationPackOptions = {},
): RubyPack {
  return {
    name: "fabrication",
    protocol: "in-process",
    discovery: [],
    factories: [
      {
        definitionMethods: ["Fabricator"],
        classKeywords: ["class_name"],
        parentKeywords: ["from"],
        nestedDefinitionsInherit: false,
        builders: [
          { method: "Fabricate" },
          { method: "build", receiver: LIBRARY },
          { method: "create", receiver: LIBRARY },
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
  package: "@suss/framework-fabrication",
  dependencies: [],
  reads:
    "Fabrication builds in tests (Ruby), typed by the class each fabricator builds, so a test's calls on them are followed.",
};

export default fabricationFramework;
