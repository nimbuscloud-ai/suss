import { describe, expect, it } from "vitest";

import { argumentForParameter } from "./passedArguments.js";

import type { RecordedArgument } from "./passedArguments.js";

const url: RecordedArgument = { kind: "string", value: "https://a" };
const post: RecordedArgument = { kind: "string", value: "post" };

/** `def send(url, body = nil, verb: :get)`, read the way a caller fills it. */
const parameters = {
  url: { name: "url", position: 0 },
  body: { name: "body", position: 1 },
  verb: { name: "verb", position: 2 },
};
const all = Object.values(parameters);

describe("argumentForParameter", () => {
  it("fills a parameter from the keyword argument written with its name", () => {
    const args: RecordedArgument[] = [
      url,
      { kind: "keywords", fields: { verb: post } },
    ];
    expect(argumentForParameter(args, parameters.url, all)).toEqual(url);
    expect(argumentForParameter(args, parameters.verb, all)).toEqual(post);
    expect(argumentForParameter(args, parameters.body, all)).toBeUndefined();
  });

  it("fills a parameter by place when the call passes it positionally", () => {
    const args: RecordedArgument[] = [url, { kind: "null" }, post];
    expect(argumentForParameter(args, parameters.verb, all)).toEqual(post);
  });

  it("gives a splat to every parameter from its place on, unless a keyword fills one", () => {
    const splat: RecordedArgument = { kind: "identifier", name: "*args" };
    const args: RecordedArgument[] = [
      url,
      splat,
      { kind: "keywords", fields: { verb: post } },
    ];
    expect(argumentForParameter(args, parameters.body, all)).toEqual(splat);
    expect(argumentForParameter(args, parameters.verb, all)).toEqual(post);
  });

  it("passes Ruby pairs no parameter is named for as one hash in the next place", () => {
    // `def fetch(url, method = :get, fields = {})`, called with `fetch(url, :post, code: c)`.
    const method = { name: "method", position: 1 };
    const fields = { name: "fields", position: 2 };
    const fetch = [{ name: "url", position: 0 }, method, fields];
    const code: RecordedArgument = { kind: "identifier", name: "c" };
    const args: RecordedArgument[] = [
      url,
      post,
      { kind: "keywords", fields: { code } },
    ];
    expect(argumentForParameter(args, method, fetch)).toEqual(post);
    expect(argumentForParameter(args, fields, fetch)).toEqual({
      kind: "object",
      fields: { code },
    });
  });
});
