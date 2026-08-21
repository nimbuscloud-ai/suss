import { describe, expect, it } from "vitest";

import { checkOneTsMorph, formatSecondCopies } from "./oneTsMorph.js";

describe("checkOneTsMorph", () => {
  it("says nothing when every pack reads the ts-morph this run parses with", () => {
    const check = checkOneTsMorph([
      { name: "prisma", specifier: "@suss/framework-prisma" },
      { name: "express", specifier: "@suss/framework-express" },
    ]);

    expect(check.ours).not.toBeNull();
    expect(check.others).toEqual([]);
    expect(formatSecondCopies(check)).toBe("");
  });

  it("leaves out a pack whose ts-morph it cannot resolve", () => {
    const check = checkOneTsMorph([
      { name: "nowhere", specifier: "@suss/framework-does-not-exist" },
    ]);

    expect(check.others).toEqual([]);
  });

  it("asks about each pack once, however many times it was named", () => {
    const twice = checkOneTsMorph([
      { name: "prisma", specifier: "@suss/framework-prisma" },
      { name: "prisma", specifier: "@suss/framework-prisma" },
    ]);

    expect(twice.others).toEqual([]);
  });
});

describe("formatSecondCopies", () => {
  it("says which pack, which version, and what to do about it", () => {
    const message = formatSecondCopies({
      ours: "23.0.0",
      others: [{ pack: "prisma", version: "28.0.0" }],
    });

    expect(message).toContain("23.0.0");
    expect(message).toContain("prisma imports ts-morph 28.0.0");
    expect(message).toContain("Installing suss and its packs at one version");
  });

  it("says nothing when this run could not read its own ts-morph", () => {
    expect(
      formatSecondCopies({
        ours: null,
        others: [{ pack: "prisma", version: "28.0.0" }],
      }),
    ).toBe("");
  });
});
