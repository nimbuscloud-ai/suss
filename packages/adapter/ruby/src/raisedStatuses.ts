/**
 * The responses the library sends for an exception a model call raises
 * when nothing in the controller rescues it.
 *
 * A storage pack says which of its methods raise which exception, such
 * as ActiveRecord's `find` raising `RecordNotFound`, and the controller
 * pack says which status the library sends for each, Rails'
 * `rescue_responses`. A body whose storage effects include one of those
 * calls gets a response for it. A `rescue_from` for that exception, or
 * for one of its ancestors, replaces the library's response with its own
 * handler, so the response is left out then.
 */

import type { Effect } from "@suss/behavioral-ir";
import type { RawBranch } from "@suss/extractor";
import type { Range } from "./ast.js";
import type { ControllerActions, RbStoragePattern } from "./pack.js";

export function raisedStatusBranches(
  pattern: ControllerActions,
  storage: readonly RbStoragePattern[],
  effects: readonly Effect[] | undefined,
  rescued: ReadonlySet<string>,
  location: Range,
): RawBranch[] {
  const statuses = pattern.exceptionStatuses ?? {};
  const operations = new Set(
    (effects ?? []).flatMap((effect) =>
      effect.type === "interaction" &&
      effect.interaction.class === "storage-access" &&
      effect.interaction.operation !== undefined
        ? [effect.interaction.operation]
        : [],
    ),
  );
  const raised = new Set(
    storage.flatMap((one) =>
      (one.raises ?? []).flatMap((raise) =>
        raise.methods.some((method) => operations.has(method))
          ? [raise.exception]
          : [],
      ),
    ),
  );
  return [...raised].flatMap((exception) => {
    const declared = statuses[exception];
    if (
      declared === undefined ||
      [exception, ...declared.ancestors].some((name) => rescued.has(name))
    ) {
      return [];
    }
    return [statusBranch(exception, declared.status, location)];
  });
}

function statusBranch(
  exception: string,
  status: number,
  location: Range,
): RawBranch {
  return {
    conditions: [
      {
        sourceText: `${exception} raised`,
        structured: null,
        polarity: "positive",
        source: "earlyThrow",
      },
    ],
    terminal: {
      kind: "response",
      statusCode: { type: "literal", value: status },
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      renderTree: null,
      delegateTarget: null,
      emitEvent: null,
      location,
    },
    effects: [],
    location,
    isDefault: false,
  };
}
