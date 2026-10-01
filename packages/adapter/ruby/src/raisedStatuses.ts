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
 * The body then gets the throw instead, with the exception's ancestry,
 * and composition puts the response of the handler that catches it
 * beside it.
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

/** What the raises in one body raise, and the handlers covering that body. */
export interface RaisesRead {
  /** The class each raise raises, or null for one the source computes. */
  classes: NodeMap<ExceptionClass | null>;
  handlers: readonly HandlerClasses[];
}

/** Whether one of the handlers covering the code catches the exception, or may. */
export function rescuedBy(
  handlers: readonly HandlerClasses[],
  exception: ExceptionClass,
): boolean {
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
 * The library's response, when no handler covering the code rescues the
 * exception and the library has one for it, or else the throw. Null for
 * an exception the source computes, which throws with no class.
 */
export function raisedTerminal(
  pattern: ControllerActions,
  exception: ExceptionClass | null,
  handlers: readonly HandlerClasses[],
  location: Range,
): RawTerminal {
  const status =
    exception === null || rescuedBy(handlers, exception)
      ? undefined
      : pattern.libraryExceptions?.[exception.name]?.status;
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
 * the library has no response for, and nothing rescues, leaves the run's
 * reading of the body as it was.
 */
export function raisedStatusBranches(
  pattern: ControllerActions,
  storage: readonly RbStoragePattern[],
  effects: readonly Effect[] | undefined,
  handlers: readonly HandlerClasses[],
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
