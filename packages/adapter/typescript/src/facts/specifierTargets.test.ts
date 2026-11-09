import { describe, expect, it } from "vitest";

import { specifierTargets } from "./specifierTargets.js";

const FROM = "/app/src/users/users.service.ts";

describe("specifierTargets", () => {
  it("points a relative specifier beside the importing file", () => {
    expect(specifierTargets(FROM, "../db/client", {})).toEqual([
      "/app/src/db/client",
    ]);
  });

  it("points a bare specifier under baseUrl", () => {
    expect(
      specifierTargets(FROM, "src/generated/prisma/client", {
        baseUrl: "/app",
      }),
    ).toEqual(["/app/src/generated/prisma/client"]);
  });

  it("points a bare specifier nowhere when the project maps none", () => {
    expect(specifierTargets(FROM, "@prisma/client", {})).toEqual([]);
  });

  it("gives every substitution of the paths pattern that covers it", () => {
    expect(
      specifierTargets(FROM, "@db/client", {
        baseUrl: "/app",
        paths: { "@db/*": ["src/generated/*", "vendor/*"] },
      }),
    ).toEqual(["/app/src/generated/client", "/app/vendor/client"]);
  });

  it("lets a matching paths pattern decide on its own, without baseUrl", () => {
    expect(
      specifierTargets(FROM, "@db/client", {
        baseUrl: "/app",
        paths: { "@db/*": ["src/generated/*"] },
      }),
    ).not.toContain("/app/@db/client");
  });

  it("takes the pattern with the longest prefix, and an exact key over both", () => {
    const options = {
      baseUrl: "/app",
      paths: {
        "@/*": ["src/*"],
        "@/db/*": ["src/generated/*"],
        "@/db/main": ["src/main-client"],
      },
    };
    expect(specifierTargets(FROM, "@/db/client", options)).toEqual([
      "/app/src/generated/client",
    ]);
    expect(specifierTargets(FROM, "@/db/main", options)).toEqual([
      "/app/src/main-client",
    ]);
  });

  it("resolves paths against the tsconfig's folder when there is no baseUrl", () => {
    expect(
      specifierTargets(FROM, "@db/client", {
        paths: { "@db/*": ["./src/generated/*"] },
        pathsBasePath: "/app",
      }),
    ).toEqual(["/app/src/generated/client"]);
  });

  it("falls back to baseUrl when no paths pattern covers the specifier", () => {
    expect(
      specifierTargets(FROM, "src/generated/client", {
        baseUrl: "/app",
        paths: { "@db/*": ["src/generated/*"] },
      }),
    ).toEqual(["/app/src/generated/client"]);
  });
});
