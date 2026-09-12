/**
 * `env.SOME_VAR` reads, as `interaction(class: "config-read")` effects.
 *
 * A Worker gets no `process.env`. Its configuration arrives as the
 * second argument to every trigger, so a read off that argument is the
 * same channel `@suss/runtime-node` recognizes for a Node process, and
 * it is recorded the same way so `checkRuntimeConfig` pairs it against
 * whatever `wrangler.toml` declares.
 *
 * The argument is found by resolving the identifier back to its
 * declaration and asking whether that parameter belongs to a trigger,
 * rather than by matching the name `env`, which is the developer's
 * choice and not Cloudflare's.
 */

import { Node as N } from "ts-morph";

import {
  isDefaultedAt,
  propertyFunctionOf,
  propertyNameOf,
} from "@suss/adapter-typescript";
import { runtimeConfigBinding } from "@suss/behavioral-ir";

import { entrypointTriggerFunctions } from "./discovery.js";
import { TRIGGERS } from "./handlers.js";

import type { ResolutionStore } from "@suss/adapter-typescript";
import type { Effect } from "@suss/behavioral-ir";
import type { AccessRecognizer } from "@suss/extractor";
import type { Node, ParameterDeclaration } from "ts-morph";

/** Which argument of a trigger the bindings arrive in. */
const ENV_PARAMETER_POSITION = 1;

/** How a config-read spells the read, so a reader sees one channel. */
const readName = (name: string): string => `env.${name}`;

export interface EnvBindingRecognizerOptions {
  /**
   * The name the deployment gives this Worker, recorded on the binding.
   * Pairing goes by the variable name, so this is informational.
   */
  scriptName?: string | undefined;
}

/**
 * Access recognizer for a Worker's binding reads. It fires on the same
 * property-access nodes every other access recognizer sees, and returns
 * null for the ones that are not a read off a trigger's env argument.
 */
export function envBindingRecognizer(
  options: EnvBindingRecognizerOptions = {},
): AccessRecognizer {
  const instanceName = options.scriptName ?? "<unknown>";
  return (access, ctx) => {
    const { resolution } = ctx as { resolution?: ResolutionStore };
    const read = envReadAt(access as Node, resolution);
    return read === null ? null : [configReadEffect(read, instanceName)];
  };
}

interface EnvRead {
  name: string;
  defaulted: boolean;
}

function envReadAt(
  node: Node,
  resolution: ResolutionStore | undefined,
): EnvRead | null {
  if (!N.isPropertyAccessExpression(node)) {
    return null;
  }
  const subject = node.getExpression();
  if (!N.isIdentifier(subject) || !isTriggerEnvArgument(subject, resolution)) {
    return null;
  }
  const name = node.getName();
  return name.length === 0 ? null : { name, defaulted: isDefaultedAt(node) };
}

/** Whether an identifier refers to the env argument of a trigger. */
export function isTriggerEnvArgument(
  subject: Node,
  resolution: ResolutionStore | undefined,
): boolean {
  for (const definition of subject.getSymbol()?.getDeclarations() ?? []) {
    if (
      N.isParameterDeclaration(definition) &&
      isTriggerEnvParameter(definition, resolution)
    ) {
      return true;
    }
  }
  return false;
}

function isTriggerEnvParameter(
  parameter: ParameterDeclaration,
  resolution: ResolutionStore | undefined,
): boolean {
  const owner = parameter.getParent() as Node & {
    getParameters?: () => ParameterDeclaration[];
  };
  const parameters = owner.getParameters?.() ?? [];
  if (parameters[ENV_PARAMETER_POSITION] !== parameter) {
    return false;
  }
  return isTriggerBody(owner, resolution);
}

/**
 * Whether a function is one of the entrypoint's triggers. Given the
 * run's store, discovery has already settled which functions those are,
 * wherever each was written. Without one, a handler written into the
 * object is all this can tell apart from any other function, and taking
 * more would make every second parameter in the file a set of bindings.
 */
function isTriggerBody(
  owner: Node,
  resolution: ResolutionStore | undefined,
): boolean {
  if (resolution !== undefined) {
    return entrypointTriggerFunctions(owner.getSourceFile(), resolution).has(
      owner,
    );
  }
  return writtenUnderTriggerName(owner);
}

/** Whether the property this function is written under names a trigger. */
function writtenUnderTriggerName(owner: Node): boolean {
  const property: Node | undefined = N.isMethodDeclaration(owner)
    ? owner
    : owner.getParent();
  if (property === undefined) {
    return false;
  }
  const name = propertyNameOf(property);
  if (name === null || TRIGGERS[name] === undefined) {
    return false;
  }
  return propertyFunctionOf(property, undefined) === owner;
}

function configReadEffect(read: EnvRead, instanceName: string): Effect {
  return {
    type: "interaction",
    binding: runtimeConfigBinding({
      recognition: "@suss/framework-cloudflare-workers",
      deploymentTarget: "worker",
      instanceName,
    }),
    callee: readName(read.name),
    interaction: {
      class: "config-read",
      name: read.name,
      defaulted: read.defaulted,
    },
  };
}
