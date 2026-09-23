/**
 * Records `env.SOME_VAR` reads as `config-read` interactions. A Worker's
 * configuration arrives as the second argument to every trigger, and a
 * read from it is recorded the same way `@suss/runtime-node` records
 * `process.env.X`, so `checkRuntimeConfig` pairs it with whatever
 * `wrangler.toml` declares.
 *
 * The recognizer finds the argument by resolving the identifier to its
 * declaration and checking that the parameter belongs to a trigger. A
 * project can call the argument anything, so matching the name `env`
 * would miss some.
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

const ENV_PARAMETER_POSITION = 1;

/** Every read is spelled `env.<name>`, so a reader sees one channel. */
const readName = (name: string): string => `env.${name}`;

export interface EnvBindingRecognizerOptions {
  /**
   * The Worker's `name` from `wrangler.toml`, recorded on the binding.
   * Pairing uses the variable name, so this value only helps a reader.
   */
  scriptName?: string | undefined;
}

/**
 * Runs on every property access, like any access recognizer, and returns
 * null unless the access reads from a trigger's env argument.
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
 * With the run's resolution store, discovery has already found the
 * trigger functions wherever they were written. Without it, only a
 * handler written into the entrypoint object can be recognized, because
 * accepting more would treat every second parameter in the file as
 * bindings.
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

/** Whether this function is the value of a property keyed by a trigger. */
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
