import { describe, expect, it } from "vitest";

import { libraryEnvReadMarkers } from "./libraryEnvReads.js";

const IMPORTERS: Record<string, string> = {
  aws_lambda_powertools: "app.py",
  tracing: "a.ts",
};

/** The first file whose import starts with the prefix, from a fixed table. */
const firstImporter = (prefix: string): string | undefined =>
  Object.entries(IMPORTERS).find(([module]) => module.startsWith(prefix))?.[1];

describe("libraryEnvReadMarkers", () => {
  it("places the marker at the importing file and records what the library reads", () => {
    const [marker] = libraryEnvReadMarkers(
      [
        {
          name: "aws-lambda-python",
          libraryEnvVars: [
            { module: "aws_lambda_powertools", prefixes: ["POWERTOOLS_"] },
          ],
        },
      ],
      firstImporter,
    );

    expect(marker?.location.file).toBe("app.py");
    expect(marker?.identity.name).toBe("aws_lambda_powertools env reads");
    expect(marker?.identity.boundaryBinding?.recognition).toBe(
      "aws-lambda-python",
    );
    expect(marker?.metadata?.libraryEnvReads).toEqual({
      module: "aws_lambda_powertools",
      prefixes: ["POWERTOOLS_"],
    });
  });

  it("records exact names when the library gives them", () => {
    const [marker] = libraryEnvReadMarkers(
      [
        {
          name: "pack",
          libraryEnvVars: [{ module: "tracing", names: ["TRACE_URL"] }],
        },
      ],
      firstImporter,
    );

    expect(marker?.metadata?.libraryEnvReads).toEqual({
      module: "tracing",
      names: ["TRACE_URL"],
    });
  });

  it("writes one marker per imported library in pack order, and none for a library no file imports", () => {
    const markers = libraryEnvReadMarkers(
      [
        { name: "first", libraryEnvVars: [{ module: "tracing" }] },
        { name: "none" },
        {
          name: "second",
          libraryEnvVars: [
            { module: "unused_sdk" },
            { module: "aws_lambda_powertools" },
          ],
        },
      ],
      firstImporter,
    );

    expect(
      markers.map((marker) => [
        marker.identity.boundaryBinding?.recognition,
        marker.location.file,
      ]),
    ).toEqual([
      ["first", "a.ts"],
      ["second", "app.py"],
    ]);
  });
});
