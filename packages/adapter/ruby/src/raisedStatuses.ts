/**
 * What an action or filter ends with when it raises: the response the
 * library sends for the exception, or a throw a handler catches.
 *
 * A raise is written in the body, or comes from a model call: a storage
 * pack says which of its methods raise which exception, such as
 * ActiveRecord's `find` raising `RecordNotFound`. The controller pack
 * says which status the library sends for each, Rails'
 * `rescue_responses`. A `rescue_from` for the exception, or for one of
 * its ancestors, replaces the library's response with its own handler.
 * The body then gets the throw, with the exception's ancestry and the
 * library's status. Composition adds the response of the handler that
 * catches it, or the library's status where no handler on the route does.
 */

import {
  classesOf,
  listedException,
  unreadException,
} from "./exceptionClasses.js";

import type { Effect } from "@suss/behavioral-ir";
import type { RawBranch, RawTerminal } from "@suss/extractor";
import type { NodeMap, Range } from "./ast.js";
import type { ExceptionClass } from "./exceptionClasses.js";
import type { ControllerActions, RbStoragePattern } from "./pack.js";

/**
 * The classes a handler is registered for, as the run read them.
 * `someUnread` says the run could not read one of them, so the handler
 * may catch anything.
 */
export interface HandlerClasses {
  classes: readonly ExceptionClass[];
  someUnread: boolean;
}

/**
 * The handlers covering a body. A filter has one unit however many
 * controllers inherit it, each with its own `rescue_from` list, so its
 * unit is read with `"eachRoute"` and composition picks the handler on
 * each route.
 */
export type CoveringHandlers = readonly HandlerClasses[] | "eachRoute";

/** What the raises in one body raise, and the handlers covering that body. */
export interface RaisesRead {
  /** The class each raise raises, or null for one the source computes. */
  classes: NodeMap<ExceptionClass | null>;
  handlers: CoveringHandlers;
}

/** Whether one of the handlers covering the code catches the exception, or may. */
export function rescuedBy(
  handlers: CoveringHandlers,
  exception: ExceptionClass,
): boolean {
  if (handlers === "eachRoute") {
    return true;
  }
  const classes = new Set(classesOf(exception));
  return handlers.some(
    (caught) =>
      caught.someUnread ||
      caught.classes.some(
        (one) =>
          classes.has(one.name) ||
          (exception.incomplete && one.inheritableByUnread),
      ),
  );
}

/**
 * The library's response, when the library has one for the exception
 * and no handler covering the code may rescue it, or else the throw. A
 * throw keeps the library's status for composition to use on a route
 * where no handler catches it. A raise of an exception the source
 * computes throws with no class.
 */
export function raisedTerminal(
  pattern: ControllerActions,
  exception: ExceptionClass | null,
  handlers: CoveringHandlers,
  location: Range,
): RawTerminal {
  const libraryStatus =
    exception === null
      ? undefined
      : pattern.libraryExceptions?.[exception.name]?.status;
  const status =
    exception === null || rescuedBy(handlers, exception)
      ? undefined
      : libraryStatus;
  return {
    kind: status === undefined ? "throw" : "response",
    statusCode:
      status === undefined ? null : { type: "literal", value: status },
    body: null,
    exceptionType: status === undefined ? (exception?.name ?? null) : null,
    ...(status === undefined && exception !== null
      ? {
          exceptionAncestry: {
            ancestors: exception.ancestors,
            incomplete: exception.incomplete,
          },
        }
      : {}),
    ...(status === undefined && libraryStatus !== undefined
      ? { statusWhenUncaught: libraryStatus }
      : {}),
    message: null,
    component: null,
    renderTree: null,
    delegateTarget: null,
    emitEvent: null,
    location,
  };
}

/**
 * One branch for each exception a model call in the body raises. A raise
 * the library has no response for, and that no handler may rescue, leaves
 * the run's reading of the body as it was.
 */
export function raisedStatusBranches(
  pattern: ControllerActions,
  storage: readonly RbStoragePattern[],
  effects: readonly Effect[] | undefined,
  handlers: CoveringHandlers,
  location: Range,
): RawBranch[] {
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
  return [...raised].flatMap((name) => {
    const exception =
      listedException(name, pattern.libraryExceptions ?? {}) ??
      unreadException(name);
    const terminal = raisedTerminal(pattern, exception, handlers, location);
    if (terminal.kind === "throw" && !rescuedBy(handlers, exception)) {
      return [];
    }
    return [
      {
        conditions: [
          {
            sourceText: `${name} raised`,
            structured: null,
            polarity: "positive",
            source: "earlyThrow",
          },
        ],
        terminal,
        effects: [],
        location,
        isDefault: false,
      },
    ];
  });
}
