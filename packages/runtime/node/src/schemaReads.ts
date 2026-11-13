/**
 * The environment variables a call reads by parsing the environment
 * against a schema, as a recognizer on the access walk's calls. The keys
 * are reported at the call that parses, and at every call into a project
 * function whose body parses, after the reads the environment chains
 * report there through a helper. schemaEnv.ts has the libraries.
 */

import { Node } from "ts-morph";

import {
  fallbackOf,
  helperCalleeOf,
  scalarValueOf,
} from "@suss/adapter-typescript";

import { configBinding } from "./configBinding.js";
import { schemaEnvReads, schemaEnvReadsInside } from "./schemaEnv.js";

import type { ResolutionStore } from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";
import type { CallExpression } from "ts-morph";
import type { DeploymentOptions } from "./configBinding.js";
import type { SchemaEnvRead } from "./schemaEnv.js";

/** The recognizer for keys read through a schema parsed against the environment. */
export function schemaReadRecognizer(
  where: DeploymentOptions = {},
): AccessRecognizer {
  return (access, ctx) => {
    const node = access as Node;
    if (!Node.isCallExpression(node)) {
      return null;
    }
    const resolution = (ctx as { resolution?: ResolutionStore } | undefined)
      ?.resolution;
    const reads = schemaReadsAt(node, resolution);
    return reads.length === 0
      ? null
      : reads.map((read) => schemaReadEffect(read, node, where, resolution));
  };
}

/**
 * The keys the call parses itself, or else the keys a project function
 * it calls parses in its own body. A config module often parses its
 * schema inside a function every handler calls.
 */
function schemaReadsAt(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): SchemaEnvRead[] {
  const parsed = schemaEnvReads(call, resolution);
  if (parsed.length > 0) {
    return parsed;
  }
  const callee = helperCalleeOf(call, resolution);
  return callee === null ? [] : schemaEnvReadsInside(callee, resolution);
}

/** A key's read records the value the call falls back to, when the key accepts a missing variable and that settles. */
function schemaReadEffect(
  read: SchemaEnvRead,
  call: CallExpression,
  where: DeploymentOptions,
  resolution: ResolutionStore | undefined,
): Effect {
  const fallback = read.defaulted ? defaultValueAt(call, resolution) : null;
  return {
    type: "interaction",
    binding: configBinding(where),
    callee: `${read.object}.${read.name}`,
    interaction: {
      class: "config-read",
      name: read.name,
      defaulted: read.defaulted,
      ...(fallback === null ? {} : { default: fallback }),
    },
  };
}

function defaultValueAt(
  call: Node,
  resolution: ResolutionStore | undefined,
): string | number | boolean | null {
  const fallback = fallbackOf(call);
  return fallback === null ? null : scalarValueOf(fallback, resolution);
}
