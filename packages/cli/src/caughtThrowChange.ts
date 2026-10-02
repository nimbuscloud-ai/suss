/**
 * Tells a diff which changed outcomes no client of a boundary can see.
 *
 * When an error handler on a route surely catches a throw, the caller
 * gets the handler's response, which composition lists beside the throw,
 * and never the throw itself. Renaming the exception class then changes
 * the throw's class and the class list the handler records, while the
 * status and body the caller gets stay the same. The diff lists such a
 * change under the unit in its file and leaves it out of the boundary's
 * block and the headline. A change to the response, its conditions, its
 * effects or whether the handler surely catches it still counts.
 */

import { readWrapperMetadata, withWrapperMetadata } from "@suss/behavioral-ir";

import type { Transition } from "@suss/behavioral-ir";

/** Whether the only difference between two versions of an outcome is one no client sees. */
export function changeNoClientSees(
  before: Transition,
  after: Transition,
): boolean {
  return (
    JSON.stringify(clientView(before)) === JSON.stringify(clientView(after))
  );
}

/** The outcome as its caller sees it, with what only the server sees taken out. */
function clientView(transition: Transition): unknown {
  return {
    output: caughtThrow(transition)
      ? { ...transition.output, ...UNNAMED_CLASS }
      : transition.output,
    conditions: transition.conditions,
    isDefault: transition.isDefault,
    effects: transition.effects,
    metadata: withoutCatchList(transition),
  };
}

const UNNAMED_CLASS = {
  exceptionType: undefined,
  exceptionAncestors: undefined,
  ancestryIncomplete: undefined,
};

function caughtThrow(transition: Transition): boolean {
  return (
    transition.output.type === "throw" &&
    readWrapperMetadata(transition)?.caught === true
  );
}

/** The metadata with the classes an error handler lists taken out of its reference. */
function withoutCatchList(transition: Transition): unknown {
  const wrappers = readWrapperMetadata(transition);
  const from = wrappers?.from;
  if (wrappers === undefined || from?.onThrow !== true) {
    return transition.metadata;
  }
  return withWrapperMetadata(transition.metadata, {
    ...wrappers,
    from: {
      ...from,
      catches: undefined,
      mayCatchUnreadClasses: undefined,
      mayCatchAny: undefined,
    },
  });
}
