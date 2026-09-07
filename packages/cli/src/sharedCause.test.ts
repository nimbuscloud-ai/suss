import { describe, expect, it } from "vitest";

import { type CausedLine, scopeLines, sharedCauses } from "./sharedCause.js";

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

/** The cases below are about the grouping, so no boundary has the line yet. */
const causesOf = (
  lines: CausedLine[],
  runsOn: () => string[],
): ReturnType<typeof sharedCauses> => sharedCauses(lines, runsOn, () => false);

describe("a change that reached many boundaries from one place", () => {
  it("lifts the line every route got from the same filter", () => {
    const causes = causesOf(
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
    const causes = causesOf(
      [line("GET /orders", "+ 401  when  session[:user_id].nil?")],
      RUNS_ON(["GET /orders"]),
    );

    expect(causes).toEqual([]);
  });

  it("leaves a line the unit's own body produced where it is", () => {
    const causes = causesOf(
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
    const causes = causesOf(
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
    const [cause] = causesOf(
      [
        line("GET /orders", "+ 401  when  session[:user_id].nil?"),
        line("POST /orders", "+ 401  when  session[:user_id].nil?"),
      ],
      RUNS_ON(["GET /orders", "POST /orders", "GET /health"]),
    );

    expect(cause?.exceptions).toEqual(["GET /health"]);
    expect(scopeLines(cause as NonNullable<typeof cause>)).toEqual([
      "at GET /orders and POST /orders",
      "not at GET /health, which it also runs on",
    ]);
  });

  it("counts the exceptions once there are too many to name", () => {
    const [cause] = causesOf(
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

    expect(scopeLines(cause as NonNullable<typeof cause>)).toEqual([
      "at GET /orders and POST /orders",
      "not at 4 others it runs on",
    ]);
  });

  it("leaves the second line off when nothing the wrapper runs on missed it", () => {
    const [cause] = causesOf(
      [line("GET /orders", "+ 401"), line("POST /orders", "+ 401")],
      RUNS_ON(["GET /orders", "POST /orders"]),
    );

    expect(scopeLines(cause as NonNullable<typeof cause>)).toEqual([
      "at GET /orders and POST /orders",
    ]);
  });

  it("leaves out a route that had the outcome already", () => {
    // GET /health responded 401 before this change, so nothing moved
    // there and a reviewer sent to look would find nothing.
    const [cause] = sharedCauses(
      [
        line("GET /orders", "+ 401  when  session[:user_id].nil?"),
        line("POST /orders", "+ 401  when  session[:user_id].nil?"),
      ],
      RUNS_ON(["GET /orders", "POST /orders", "GET /health"]),
      (boundary, outcome) =>
        boundary === "GET /health" &&
        outcome === "401  when  session[:user_id].nil?",
    );

    expect(cause?.exceptions).toEqual([]);
  });

  it("counts the boundaries once there are too many to name", () => {
    const many = ["GET /a", "GET /b", "GET /c", "GET /d"];
    const [cause] = causesOf(
      many.map((boundary) => line(boundary, "+ 401")),
      RUNS_ON(many),
    );

    expect(scopeLines(cause as NonNullable<typeof cause>)).toEqual([
      "at 4 of the 4 boundaries it runs on",
    ]);
  });

  it("falls back on the boundaries it saw when nothing says what the wrapper covers", () => {
    const [cause] = causesOf(
      [line("GET /orders", "+ 401"), line("POST /orders", "+ 401")],
      RUNS_ON([]),
    );

    expect(cause?.covered).toBe(2);
    expect(cause?.exceptions).toEqual([]);
  });
});
