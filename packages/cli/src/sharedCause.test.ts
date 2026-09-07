import { describe, expect, it } from "vitest";

import { type CausedLine, scopeLine, sharedCauses } from "./sharedCause.js";

const FILTER = {
  file: "app/controllers/application_controller.rb",
  name: "require_login",
};
const OTHER = { file: "app/middleware/rate_limit.rb", name: "rate_limit" };

/** One route's line, as the report has it before anything is lifted out. */
function line(
  boundary: string,
  text: string,
  wrapper: CausedLine["wrapper"] = FILTER,
): CausedLine {
  return {
    key: `app/controllers/orders.rb::${boundary}`,
    boundary,
    text,
    wrapper,
  };
}

const RUNS_ON = (boundaries: string[]) => () => boundaries;

describe("a change that reached many boundaries from one place", () => {
  it("lifts the line every route got from the same filter", () => {
    const causes = sharedCauses(
      [
        line("GET /orders", "+ 401  when  session[:user_id].nil?"),
        line("POST /orders", "+ 401  when  session[:user_id].nil?"),
      ],
      RUNS_ON(["GET /orders", "POST /orders"]),
    );

    expect(causes).toHaveLength(1);
    expect(causes[0]?.wrapper).toEqual(FILTER);
    expect(causes[0]?.keys.size).toBe(2);
  });

  it("leaves a line only one boundary got where it is", () => {
    const causes = sharedCauses(
      [line("GET /orders", "+ 401  when  session[:user_id].nil?")],
      RUNS_ON(["GET /orders"]),
    );

    expect(causes).toEqual([]);
  });

  it("leaves a line the unit's own body produced where it is", () => {
    const causes = sharedCauses(
      [
        {
          ...line("GET /orders", "+ 404  when  order.nil?"),
          wrapper: undefined,
        },
        {
          ...line("POST /orders", "+ 404  when  order.nil?"),
          wrapper: undefined,
        },
      ],
      RUNS_ON(["GET /orders", "POST /orders"]),
    );

    expect(causes).toEqual([]);
  });

  it("keeps two wrappers that produced the same line apart", () => {
    const causes = sharedCauses(
      [
        line("GET /orders", "+ 429  when  over_limit?"),
        line("POST /orders", "+ 429  when  over_limit?"),
        line("GET /health", "+ 429  when  over_limit?", OTHER),
        line("POST /health", "+ 429  when  over_limit?", OTHER),
      ],
      RUNS_ON([]),
    );

    expect(causes.map((cause) => cause.wrapper.name)).toEqual([
      "require_login",
      "rate_limit",
    ]);
  });

  it("names the routes the wrapper runs on that did not get it", () => {
    const [cause] = sharedCauses(
      [
        line("GET /orders", "+ 401  when  session[:user_id].nil?"),
        line("POST /orders", "+ 401  when  session[:user_id].nil?"),
      ],
      RUNS_ON(["GET /orders", "POST /orders", "GET /health"]),
    );

    expect(cause?.exceptions).toEqual(["GET /health"]);
    expect(scopeLine(cause as NonNullable<typeof cause>)).toBe(
      "at 2 of the 3 boundaries it runs on; GET /health is the exception",
    );
  });

  it("counts the exceptions once there are too many to name", () => {
    const [cause] = sharedCauses(
      [line("GET /orders", "+ 401"), line("POST /orders", "+ 401")],
      RUNS_ON([
        "GET /orders",
        "POST /orders",
        "GET /a",
        "GET /b",
        "GET /c",
        "GET /d",
      ]),
    );

    expect(scopeLine(cause as NonNullable<typeof cause>)).toBe(
      "at 2 of the 6 boundaries it runs on; 4 of them do not have it",
    );
  });

  it("says so when every boundary the wrapper runs on got it", () => {
    const [cause] = sharedCauses(
      [line("GET /orders", "+ 401"), line("POST /orders", "+ 401")],
      RUNS_ON(["GET /orders", "POST /orders"]),
    );

    expect(scopeLine(cause as NonNullable<typeof cause>)).toBe(
      "at 2 of the 2 boundaries it runs on, all of them",
    );
  });

  it("falls back on the boundaries it saw when nothing says what the wrapper covers", () => {
    const [cause] = sharedCauses(
      [line("GET /orders", "+ 401"), line("POST /orders", "+ 401")],
      RUNS_ON([]),
    );

    expect(cause?.covered).toBe(2);
    expect(cause?.exceptions).toEqual([]);
  });
});
