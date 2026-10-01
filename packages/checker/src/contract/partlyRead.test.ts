import { describe, expect, it } from "vitest";

import { withWrapperMetadata } from "@suss/behavioral-ir";

import { provider, response, transition } from "../__fixtures__/pairs.js";
import { reachedThroughUnreadCondition } from "./partlyRead.js";

const HANDLER = {
  file: "app/controllers/base.rb",
  name: "refuse",
  onThrow: true,
};

describe("reachedThroughUnreadCondition", () => {
  it("counts an error handler's outcome the run could not tell it catches", () => {
    const uncertain = {
      ...transition("t-403", { output: response(403) }),
      metadata: withWrapperMetadata(undefined, {
        from: HANDLER,
        catchUncertain: true,
      }),
    };
    expect(
      reachedThroughUnreadCondition(provider("update", [uncertain]), uncertain),
    ).toBe(true);
  });

  it("leaves an error handler's outcome alone when the run knows it catches the throw", () => {
    const sure = {
      ...transition("t-403", { output: response(403) }),
      metadata: withWrapperMetadata(undefined, { from: HANDLER }),
    };
    expect(
      reachedThroughUnreadCondition(provider("update", [sure]), sure),
    ).toBe(false);
  });
});
