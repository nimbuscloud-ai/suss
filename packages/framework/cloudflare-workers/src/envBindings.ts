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

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import { TRIGGERS } from "./handlers.js";

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
  scriptName?: string;
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
  return (access) => {
    const read = envReadAt(access as Node);
    return read === null ? null : [configReadEffect(read, instanceName)];
  };
}

interface EnvRead {
  name: string;
  defaulted: boolean;
}

function envReadAt(node: Node): EnvRead | null {
  if (!N.isPropertyAccessExpression(node)) {
    return null;
  }
  const subject = node.getExpression();
  if (!N.isIdentifier(subject) || !isTriggerEnvArgument(subject)) {
    return null;
  }
  const name = node.getName();
  return name.length === 0 ? null : { name, defaulted: isDefaultedAt(node) };
}

/** Whether an identifier refers to the env argument of a trigger. */
function isTriggerEnvArgument(subject: Node): boolean {
  for (const definition of subject.getSymbol()?.getDeclarations() ?? []) {
    if (
      N.isParameterDeclaration(definition) &&
      isTriggerEnvParameter(definition)
    ) {
      return true;
    }
  }
  return false;
}

function isTriggerEnvParameter(parameter: ParameterDeclaration): boolean {
  const owner = parameter.getParent() as Node & {
    getParameters?: () => ParameterDeclaration[];
  };
  const parameters = owner.getParameters?.() ?? [];
  if (parameters[ENV_PARAMETER_POSITION] !== parameter) {
    return false;
  }
  return isTriggerBody(owner);
}

/**
 * Whether a function is one of the entrypoint's triggers. A method or a
 * property of the object a file default-exports is one, and so is a
 * named function that object refers to.
 */
function isTriggerBody(owner: Node): boolean {
  const named = triggerNameOf(owner);
  if (named !== null) {
    return TRIGGERS[named] !== undefined;
  }
  return referredToByEntrypoint(owner);
}

/** The property name a function is written under, when it is written under one. */
function triggerNameOf(owner: Node): string | null {
  if (N.isMethodDeclaration(owner)) {
    const name = owner.getNameNode();
    return N.isIdentifier(name) ? name.getText() : null;
  }
  const parent = owner.getParent();
  if (parent !== undefined && N.isPropertyAssignment(parent)) {
    const name = parent.getNameNode();
    return N.isIdentifier(name) ? name.getText() : null;
  }
  return null;
}

/**
 * Whether the file's default export puts this function under a trigger
 * name. A service that writes its handler as a top-level `async function
 * handleFetch(request, env)` and exports `{ fetch: handleFetch }` reads
 * its bindings there, and the read is on the same channel.
 *
 * Only the entrypoint's own properties are read. Everything the handler
 * body mentions is inside that expression too, and taking those would
 * make every second parameter in the file a set of bindings.
 */
function referredToByEntrypoint(owner: Node): boolean {
  const name = declaredName(owner);
  if (name === null) {
    return false;
  }
  const assignment = owner
    .getSourceFile()
    .getExportAssignment((a) => !a.isExportEquals());
  if (assignment === undefined) {
    return false;
  }
  return triggerReferences(assignment.getExpression()).has(name);
}

function declaredName(owner: Node): string | null {
  if (N.isFunctionDeclaration(owner)) {
    return owner.getName() ?? null;
  }
  const parent = owner.getParent();
  return parent !== undefined && N.isVariableDeclaration(parent)
    ? parent.getName()
    : null;
}

/** The function each trigger property of an entrypoint object refers to. */
function triggerReferences(expression: Node): Set<string> {
  const names = new Set<string>();
  if (!N.isObjectLiteralExpression(expression)) {
    return names;
  }
  for (const property of expression.getProperties()) {
    if (!N.isPropertyAssignment(property)) {
      continue;
    }
    const key = property.getNameNode();
    if (!N.isIdentifier(key) || TRIGGERS[key.getText()] === undefined) {
      continue;
    }
    const written = property.getInitializer();
    if (written !== undefined && N.isIdentifier(written)) {
      names.add(written.getText());
    }
  }
  return names;
}

/**
 * Whether something else supplies a value when the binding is absent.
 * `env.X ?? "default"` and `env.X || other` both do, and so does the
 * middle of a chain. The climb stops where the read is the last operand,
 * which is where its absence propagates.
 */
function isDefaultedAt(node: Node): boolean {
  let child: Node = node;
  let parent = child.getParent();
  while (parent !== undefined) {
    if (N.isParenthesizedExpression(parent)) {
      child = parent;
      parent = parent.getParent();
      continue;
    }
    if (!N.isBinaryExpression(parent)) {
      return false;
    }
    const operator = parent.getOperatorToken().getText();
    if (operator !== "??" && operator !== "||") {
      return false;
    }
    if (parent.getLeft() === child) {
      return true;
    }
    child = parent;
    parent = parent.getParent();
  }
  return false;
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
