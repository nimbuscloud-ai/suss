/**
 * redirectDelivery.ts: whether one client call follows redirects, when
 * the call or the instance it is made on says so.
 *
 * A pack declares what its client does with a redirect by default, and
 * which request option changes it: `fetch(url, { redirect: "manual" })`
 * or `axios.create({ maxRedirects: 0 })` hands the 3xx back. The option
 * is read off the call's options object first and off the instance's
 * config second, through the value evaluator. A value it cannot settle
 * says nothing, and the pack's default applies.
 */

import { redirectDeliveryWhenSet } from "@suss/extractor";
import { force, scalarOf } from "@suss/values";

import { evaluatedValue } from "../values/evaluator.js";
import { clientConstructionConfig } from "./clientBasePath.js";

import type {
  DiscoveryPattern,
  PatternPack,
  RedirectDelivery,
} from "@suss/extractor";
import type { Node } from "ts-morph";
import type { DiscoveredUnit } from "../discovery/index.js";
import type { ResolutionStore } from "../facts/store.js";

type Setting =
  | { kind: "settled"; value: string | number | boolean }
  | { kind: "absent" }
  | { kind: "unknown" };

/** What an options object says about one option. */
function settingOf(
  object: Node | undefined,
  name: string,
  resolution: ResolutionStore | undefined,
  site: string | undefined,
): Setting {
  if (object === undefined) {
    return { kind: "absent" };
  }
  const value = evaluatedValue(object, resolution, site);
  if (value.kind !== "record") {
    return { kind: "unknown" };
  }

  const field = value.fields.get(name);
  if (field === undefined) {
    return value.open ? { kind: "unknown" } : { kind: "absent" };
  }

  if (field.presence !== "one") {
    return { kind: "unknown" };
  }
  const settled = scalarOf(force(field.value));
  return settled === null
    ? { kind: "unknown" }
    : { kind: "settled", value: settled };
}

/**
 * What this call does with a redirect when it or its instance sets the
 * pack's redirect option, or undefined when neither settles it.
 */
export function redirectDeliveryAtCall(
  callSite: NonNullable<DiscoveredUnit["callSite"]>,
  pattern: DiscoveryPattern,
  pack: PatternPack,
  resolution: ResolutionStore | undefined,
): RedirectDelivery | undefined {
  const option = pack.redirectOption;
  if (option === undefined) {
    return undefined;
  }
  const position = pattern.bindingExtraction?.options?.position;
  const options =
    position === undefined
      ? undefined
      : callSite.callExpression.getArguments()[position];
  const atCall = settingOf(options, option.name, resolution, callSite.under);
  const setting =
    atCall.kind === "absent"
      ? settingOf(
          clientConstructionConfig(
            callSite.callExpression,
            pattern.match,
            resolution,
          ),
          option.name,
          resolution,
          callSite.under,
        )
      : atCall;
  return setting.kind === "settled"
    ? redirectDeliveryWhenSet(option, setting.value)
    : undefined;
}
