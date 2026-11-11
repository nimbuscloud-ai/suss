/**
 * The pack's `discoverUnits` callback. It reads the object the entrypoint
 * default-exports, and the older `addEventListener("fetch", handler)`
 * form, and emits one unit per trigger. A trigger written elsewhere and
 * referred to by name is followed to its declaration, because most
 * services move a long handler out of the entrypoint file.
 */

import { Node as N } from "ts-morph";

import {
  functionValueOf,
  peelValue,
  propertiesOf,
  propertyFunctionOf,
  propertyNameOf,
  readName,
} from "@suss/adapter-typescript";

import { TRIGGERS } from "./handlers.js";

import type {
  FunctionRoot,
  ResolutionStore,
  TsDiscoveryContext,
} from "@suss/adapter-typescript";
import type { DiscoveredCustomUnit, PatternPack } from "@suss/extractor";
import type { Node, ObjectLiteralExpression, SourceFile } from "ts-morph";

/** Metadata namespace stamped on every unit this pack discovers. */
export const METADATA_NAMESPACE = "cloudflareWorkers";

/** How a trigger was registered, recorded so a reader can tell them apart. */
type Registration = "default-export" | "addEventListener";

interface Trigger {
  name: string;
  func: FunctionRoot;
  registration: Registration;
}

export interface CloudflareWorkersDiscoveryOptions {
  /**
   * The Worker's `name` from `wrangler.toml`. Without it a unit does not
   * record a deployable, and the runtime-config provider from
   * `wrangler.toml` is matched to the code by directory.
   */
  scriptName?: string | undefined;
}

export function cloudflareWorkersDiscovery(
  options: CloudflareWorkersDiscoveryOptions = {},
): NonNullable<PatternPack["discoverUnits"]> {
  return (sourceFile, ctx) => {
    const sf = sourceFile as SourceFile;
    const { resolution } = ctx as TsDiscoveryContext;
    const exported = defaultExportTriggers(sf, resolution);
    recordTriggerFunctions(exported, resolution);
    // The adapter keeps one unit per function, kind and binding, so a
    // function registered both ways is one unit and two functions
    // registered under one trigger are two.
    return [...exported, ...listenerTriggers(sf, resolution)].map((trigger) =>
      unitFor(trigger, options.scriptName),
    );
  };
}

function unitFor(
  trigger: Trigger,
  scriptName: string | undefined,
): DiscoveredCustomUnit {
  const shape = TRIGGERS[trigger.name] as (typeof TRIGGERS)[string];
  return {
    func: trigger.func,
    kind: shape.kind,
    name: trigger.name,
    ...(shape.routeInfo !== undefined ? { routeInfo: shape.routeInfo } : {}),
    ...(shape.channelInfo !== undefined
      ? { channelInfo: shape.channelInfo }
      : {}),
    ...(scriptName !== undefined
      ? {
          deployableUnit: {
            deploymentTarget: "worker" as const,
            instanceName: scriptName,
          },
        }
      : {}),
    metadata: {
      [METADATA_NAMESPACE]: {
        trigger: trigger.name,
        registration: trigger.registration,
      },
    },
  };
}

/**
 * `exportedFunctions` lists only exports declared as functions, and an
 * entrypoint exports an object, so this reads the object itself.
 */
function defaultExportTriggers(
  sf: SourceFile,
  resolution: ResolutionStore,
): Trigger[] {
  const literal = defaultExportObject(sf, resolution);
  if (literal === null) {
    return [];
  }

  const triggers: Trigger[] = [];
  for (const property of propertiesOf(literal, resolution)) {
    const name = propertyNameOf(property);
    if (name === null || TRIGGERS[name] === undefined) {
      continue;
    }
    const func = propertyFunctionOf(property, resolution);
    if (func !== null) {
      triggers.push({ name, func, registration: "default-export" });
    }
  }
  return triggers;
}

/**
 * Whether discovery found this function as a trigger of an entrypoint's
 * default export in this run. The function can be written in another
 * file than the entrypoint, imported and spread in, and the adapter
 * extracts a unit's body only after discovery found it, so asking the
 * run's own record reaches it wherever it is.
 */
export function isEntrypointTrigger(
  func: Node,
  resolution: ResolutionStore,
): boolean {
  return triggerFunctionsPerRun.get(resolution)?.has(func) ?? false;
}

function recordTriggerFunctions(
  triggers: readonly Trigger[],
  resolution: ResolutionStore,
): void {
  let found = triggerFunctionsPerRun.get(resolution);
  if (found === undefined) {
    found = new Set();
    triggerFunctionsPerRun.set(resolution, found);
  }
  for (const trigger of triggers) {
    found.add(trigger.func);
  }
}

const triggerFunctionsPerRun = new WeakMap<ResolutionStore, Set<Node>>();

/**
 * The object the file default-exports, written in place or referred to
 * by name.
 */
export function defaultExportObject(
  sf: SourceFile,
  resolution: ResolutionStore,
): ObjectLiteralExpression | null {
  for (const exported of resolution.exportsOf(sf).get("default") ?? []) {
    const object = resolution.resolveObject(exported);
    if (object !== null && N.isObjectLiteralExpression(object)) {
      return object;
    }
  }
  return null;
}

/**
 * A registration the module body makes, outside every function, since
 * that is where a service worker registers what the platform calls. A
 * registration inside a function runs only if something calls it.
 */
function listenerTriggers(
  sf: SourceFile,
  resolution: ResolutionStore,
): Trigger[] {
  const triggers: Trigger[] = [];
  sf.forEachDescendant((node, traversal) => {
    if (N.isFunctionLikeDeclaration(node)) {
      traversal.skip();
      return;
    }
    const registered = listenerAt(node, resolution);
    if (registered === null) {
      return;
    }
    const func = functionValueOf(registered.handler, resolution);
    if (func !== null) {
      triggers.push({
        name: registered.event,
        func,
        registration: "addEventListener",
      });
    }
  });
  return triggers;
}

/**
 * The event name is read the way a name is read anywhere, so one kept in
 * a const is read too. A name nothing settles is not a trigger.
 */
function listenerAt(
  node: Node,
  resolution: ResolutionStore,
): { event: string; handler: Node } | null {
  if (!N.isCallExpression(node)) {
    return null;
  }
  const callee = peelValue(node.getExpression());
  if (!N.isIdentifier(callee) || callee.getText() !== "addEventListener") {
    return null;
  }
  const [event, handler] = node.getArguments();
  if (event === undefined || handler === undefined) {
    return null;
  }
  const name = readName(peelValue(event), {
    unsettled: "nothing",
    resolve: (value) => resolution.resolveWrittenValue(value),
  });
  if (name === null || TRIGGERS[name] === undefined) {
    return null;
  }
  return { event: name, handler };
}
