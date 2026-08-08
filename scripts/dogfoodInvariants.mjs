// dogfoodInvariants.mjs
//
// The things that have to be true of any dogfood run, whatever source it
// ran over. Each one is checked against the run alone, with no baseline
// and no history, so moving an export between packages or deleting a
// function cannot break them. A count can only say suss saw fewer things
// than it did yesterday; these say suss lost track of something it can
// see for itself.
//
// The export check reads each package's declared entry points out of its
// own manifest and asks the TypeScript compiler which of them are
// callable. That is a second opinion on the export surface, arrived at
// without suss, which is what makes it worth asserting. The dogfood
// count reads the same surface from the same place.

import { declaredExports } from "./declaredSurface.mjs";

/**
 * How many consumers may go unpaired while their provider is in the
 * same run. Eight today, and every one of them has a cause written up
 * under `## Where the unmatched summaries come from` in the dogfooding
 * notes. What bounds this number is how well suss resolves, not how many
 * exports the repo happens to have, which is why it can be a fixed
 * ceiling at all. Lowering it is a fix landing; raising it needs an
 * explanation in the same place.
 */
const KNOWN_UNPAIRED_CONSUMERS = 8;

/**
 * Every function a package says it exports has a provider summary.
 *
 * This is what the per-package provider counts were standing in for, and
 * it survives the refactors a count cannot. Move an export to another
 * package and both sides still balance. Delete one and there is nothing
 * left to require. Strip a package back to types and it asks for
 * nothing at all.
 */
function missingProviders(packages) {
  const violations = [];
  for (const pkg of packages) {
    const provided = new Set(
      pkg.summaries
        .filter((s) => s.kind === "library")
        .map((s) =>
          s.identity.boundaryBinding?.semantics?.exportPath?.join("."),
        )
        .filter((key) => key !== undefined),
    );

    for (const declared of declaredExports(pkg.packageJson, pkg.dir)) {
      if (!declared.callable || provided.has(declared.path)) {
        continue;
      }
      violations.push({
        label: declared.label,
        detail: "declared as a callable export but produced no summary",
      });
    }
  }
  return violations;
}

/**
 * Anything a pack recognised has the package and export path a
 * pairing key is built from.
 *
 * The transitive closure is the one exception. A helper the closure
 * reaches is inside a package rather than on its edge, so it has no
 * export path, cannot pair, and `pairSummaries` reports it as
 * unpairable. Every other summary came from a pack that matched a
 * boundary, and a boundary with no name on it is a pairing key that
 * stopped being built.
 */
function bindingsWithoutIdentity(packages) {
  const violations = [];
  for (const pkg of packages) {
    for (const summary of pkg.summaries) {
      const binding = summary.identity.boundaryBinding;
      if (binding?.recognition === "reachable") {
        continue;
      }

      const semantics = binding?.semantics;
      const named =
        typeof semantics?.package === "string" &&
        semantics.package.length > 0 &&
        Array.isArray(semantics.exportPath) &&
        semantics.exportPath.length > 0;
      if (named) {
        continue;
      }

      violations.push({
        label: `${pkg.name}::${summary.identity.name}`,
        detail: `recognised by ${binding?.recognition ?? "no pack"} but carries no package and export path`,
      });
    }
  }
  return violations;
}

/**
 * Nothing goes unpaired whose provider is sitting right there.
 *
 * A consumer gives the package and export it called. When that export
 * has a provider summary in the same run and the two still do not pair,
 * resolution failed.
 */
function unpairedConsumers(pairing) {
  const count = pairing.unmatched.consumers.length;
  if (count <= KNOWN_UNPAIRED_CONSUMERS) {
    return [];
  }

  return [
    {
      label: "unmatched consumers",
      detail: `${count}, above the ${KNOWN_UNPAIRED_CONSUMERS} this workspace knows about`,
    },
  ];
}

/**
 * Run every invariant over one dogfood run and return what failed,
 * grouped by which invariant caught it. `packages` has the summaries
 * each package produced; `pairing` is what `pairSummaries` returned for
 * all of them together.
 */
export function evaluateInvariants({ packages, pairing }) {
  return [
    {
      name: "every declared export produces a summary",
      violations: missingProviders(packages),
    },
    {
      name: "every recognised boundary carries a pairing key",
      violations: bindingsWithoutIdentity(packages),
    },
    {
      name: "every consumer pairs with the provider in front of it",
      violations: unpairedConsumers(pairing),
    },
  ];
}
