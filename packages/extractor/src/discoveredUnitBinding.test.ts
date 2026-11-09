import { describe, expect, it } from "vitest";

import {
  bindingOfDiscoveredUnit,
  functionCallBindingOfDiscoveredUnit,
} from "./discoveredUnitBinding.js";
import { declaredMatchOf } from "./framework.js";

const PACK = { name: "lambda", protocol: "http" };

describe("bindingOfDiscoveredUnit", () => {
  it("binds a resolver field under the pack's protocol, or the transport the unit states", () => {
    const field = { typeName: "Query", fieldName: "order" };
    expect(
      bindingOfDiscoveredUnit({ resolverInfo: field }, PACK)?.transport,
    ).toBe("http");
    expect(
      bindingOfDiscoveredUnit(
        { resolverInfo: { ...field, transport: "aws-https" } },
        PACK,
      ),
    ).toMatchObject({
      transport: "aws-https",
      recognition: "lambda",
      semantics: { name: "graphql-resolver", typeName: "Query" },
    });
  });

  it("binds a route, a channel and a deployed unit, and nothing for a unit that states none", () => {
    expect(
      bindingOfDiscoveredUnit(
        { routeInfo: { method: "GET", path: "/orders" } },
        PACK,
      )?.semantics.name,
    ).toBe("rest");
    expect(
      bindingOfDiscoveredUnit(
        { channelInfo: { messageBus: "aws_sqs", channel: null } },
        PACK,
      )?.semantics.name,
    ).toBe("message-bus");
    expect(
      bindingOfDiscoveredUnit(
        {
          invocationInfo: {
            deploymentTarget: "lambda",
            instanceName: "Orders",
          },
        },
        PACK,
      )?.semantics.name,
    ).toBe("unit-invocation");
    expect(bindingOfDiscoveredUnit({}, PACK)).toBeNull();
  });

  it("makes a unit that states no boundary a function call, keyed by its module when the pack says which", () => {
    expect(functionCallBindingOfDiscoveredUnit({}, PACK).semantics).toEqual({
      name: "function-call",
    });
    expect(
      functionCallBindingOfDiscoveredUnit(
        { functionCallInfo: { module: "/app/actions.ts", exportName: "save" } },
        PACK,
      ).semantics,
    ).toMatchObject({ module: "/app/actions.ts", exportName: "save" });
  });
});

describe("declaredMatchOf", () => {
  it("leaves a namedExport with only names to the TypeScript handler, and takes one with any other field", () => {
    expect(declaredMatchOf({ type: "namedExport", names: ["loader"] })).toBe(
      null,
    );
    expect(
      declaredMatchOf({ type: "namedExport", names: ["x"], skipFiles: [] }),
    ).not.toBeNull();
    expect(
      declaredMatchOf({ type: "namedExport", pattern: "^[A-Z]" }),
    ).not.toBeNull();
    expect(
      declaredMatchOf({
        type: "namedExport",
        names: ["x"],
        bodyEndsIn: "element",
      }),
    ).not.toBeNull();
    expect(
      declaredMatchOf({
        type: "namedExport",
        names: ["default"],
        members: { named: {} },
      }),
    ).not.toBeNull();
  });

  it("takes the members only the module ops read, and leaves the rest", () => {
    expect(declaredMatchOf({ type: "manifest", entries: () => [] })?.type).toBe(
      "manifest",
    );
    expect(
      declaredMatchOf({
        type: "fileConvention",
        filePattern: "**/*.ts",
        exportNames: ["GET"],
      }),
    ).toBeNull();
  });
});
