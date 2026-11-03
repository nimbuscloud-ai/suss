import { describe, expect, it } from "vitest";

import {
  configuredCallOption,
  scopeOption,
  storageSystemOption,
} from "./packOptions.js";

describe("storageSystemOption", () => {
  it("takes each system a provider summary can spell", () => {
    for (const system of ["postgresql", "mysql", "sqlite"]) {
      expect(storageSystemOption.safeParse(system).success).toBe(true);
    }
  });

  it('refuses "postgres", the spelling that used to pair with nothing', () => {
    const parsed = storageSystemOption.safeParse("postgres");
    expect(parsed.success).toBe(false);
  });
});

describe("scopeOption", () => {
  it("takes any label a project gives a connection", () => {
    expect(scopeOption.parse("reporting")).toBe("reporting");
  });
});

describe("configuredCallOption", () => {
  it("takes a dispatcher with the body argument left out", () => {
    expect(
      configuredCallOption.safeParse({
        module: "@acme/async",
        receiver: "CommandDispatcher",
        method: "dispatch",
        subjectArg: 0,
      }).success,
    ).toBe(true);
  });

  it("refuses a key it does not declare", () => {
    const parsed = configuredCallOption.safeParse({
      module: "@acme/async",
      receiver: "CommandDispatcher",
      method: "dispatch",
      subjectArg: 0,
      bodyArgument: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it("takes an export with the positions of its subject and payload", () => {
    expect(
      configuredCallOption.safeParse({
        module: "@acme/ledger-native",
        export: "publishEntry",
        subject: { at: 0 },
        payload: { at: 1 },
      }).success,
    ).toBe(true);
  });

  it("takes a dispatcher that keeps the export a draft wrote", () => {
    expect(
      configuredCallOption.safeParse({
        module: "@acme/async",
        export: "CommandDispatcher.dispatch",
        receiver: "CommandDispatcher",
        method: "dispatch",
        subjectArg: 0,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["no export", { subject: { at: 0 } }],
    ["a bare number for the subject", { export: "send", subject: 0 }],
    ["a negative position", { export: "send", subject: { at: -1 } }],
    [
      "keys from both forms",
      { export: "send", subject: { at: 0 }, method: "send" },
    ],
  ])("refuses an export call with %s", (_, spec) => {
    expect(
      configuredCallOption.safeParse({ module: "@acme/kit", ...spec }).success,
    ).toBe(false);
  });
});
