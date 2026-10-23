import { describe, expect, it } from "vitest";

import { libraryEnvReadMarker } from "./libraryEnvReads.js";

describe("libraryEnvReadMarker", () => {
  it("places the marker at the importing file and records what the library reads", () => {
    const marker = libraryEnvReadMarker(
      "aws-lambda-python",
      { module: "aws_lambda_powertools", prefixes: ["POWERTOOLS_"] },
      "app.py",
    );

    expect(marker.location.file).toBe("app.py");
    expect(marker.identity.name).toBe("aws_lambda_powertools env reads");
    expect(marker.identity.boundaryBinding?.recognition).toBe(
      "aws-lambda-python",
    );
    expect(marker.metadata?.libraryEnvReads).toEqual({
      module: "aws_lambda_powertools",
      prefixes: ["POWERTOOLS_"],
    });
  });

  it("records exact names when the library gives them", () => {
    const marker = libraryEnvReadMarker(
      "pack",
      { module: "tracing", names: ["TRACE_URL"] },
      "a.ts",
    );

    expect(marker.metadata?.libraryEnvReads).toEqual({
      module: "tracing",
      names: ["TRACE_URL"],
    });
  });
});
