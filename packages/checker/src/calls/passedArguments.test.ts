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

describe("argumentForParameter", () => {
  it("fills a parameter from the keyword argument written with its name", () => {
    const args: RecordedArgument[] = [
      url,
      { kind: "keywords", fields: { verb: post } },
    ];
    expect(argumentForParameter(args, parameters.url)).toEqual(url);
    expect(argumentForParameter(args, parameters.verb)).toEqual(post);
    expect(argumentForParameter(args, parameters.body)).toBeUndefined();
  });

  it("fills a parameter by place when the call passes it positionally", () => {
    const args: RecordedArgument[] = [url, { kind: "null" }, post];
    expect(argumentForParameter(args, parameters.verb)).toEqual(post);
  });

  it("gives a splat to every parameter from its place on, unless a keyword fills one", () => {
    const splat: RecordedArgument = { kind: "identifier", name: "*args" };
    const args: RecordedArgument[] = [
      url,
      splat,
      { kind: "keywords", fields: { verb: post } },
    ];
    expect(argumentForParameter(args, parameters.body)).toEqual(splat);
    expect(argumentForParameter(args, parameters.verb)).toEqual(post);
  });
});
