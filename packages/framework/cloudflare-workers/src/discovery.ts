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
  propertiesOf,
  propertyFunctionOf,
  propertyNameOf,
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
    const triggers = [
      ...defaultExportTriggers(sf, resolution),
      ...listenerTriggers(sf, resolution),
    ];

    const units: DiscoveredCustomUnit[] = [];
    const taken = new Set<string>();
    for (const trigger of triggers) {
      if (taken.has(trigger.name)) {
        continue;
      }
      taken.add(trigger.name);
      units.push(unitFor(trigger, options.scriptName));
    }
    return units;
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
 * The functions the entrypoint's trigger properties refer to, written in
 * the object or referred to by name. The env-binding recognizer calls
 * this for every property read in the file, so the result is cached for
 * as long as the run's resolution store lives.
 */
export function entrypointTriggerFunctions(
  sf: SourceFile,
  resolution: ResolutionStore,
): Set<Node> {
  let perRun = triggerFunctionsPerRun.get(resolution);
  if (perRun === undefined) {
    perRun = new Map();
    triggerFunctionsPerRun.set(resolution, perRun);
  }
  const filePath = sf.getFilePath();
  let found = perRun.get(filePath);
  if (found === undefined) {
    found = new Set(
      defaultExportTriggers(sf, resolution).map((trigger) => trigger.func),
    );
    perRun.set(filePath, found);
  }
  return found;
}

const triggerFunctionsPerRun = new WeakMap<
  ResolutionStore,
  Map<string, Set<Node>>
>();

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
 * Only a string literal event name is read, since nothing can pair with
 * a name computed at run time.
 */
function listenerTriggers(
  sf: SourceFile,
  resolution: ResolutionStore,
): Trigger[] {
  const triggers: Trigger[] = [];
  sf.forEachDescendant((node) => {
    const registered = listenerAt(node);
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

function listenerAt(node: Node): { event: string; handler: Node } | null {
  if (!N.isCallExpression(node)) {
    return null;
  }
  const callee = node.getExpression();
  if (!N.isIdentifier(callee) || callee.getText() !== "addEventListener") {
    return null;
  }
  const [event, handler] = node.getArguments();
  if (event === undefined || handler === undefined) {
    return null;
  }
  if (
    !N.isStringLiteral(event) ||
    TRIGGERS[event.getLiteralValue()] === undefined
  ) {
    return null;
  }
  return { event: event.getLiteralValue(), handler };
}
