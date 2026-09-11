import { describe, expect, it } from "vitest";

import { associationTargetName, camelize, singularize } from "./inflect.js";

describe("singularize", () => {
  it.each([
    ["statuses", "status"],
    ["media_attachments", "media_attachment"],
    ["people", "person"],
    ["addresses", "address"],
    ["categories", "category"],
    ["aliases", "alias"],
    ["children", "child"],
    ["men", "man"],
    ["mice", "mouse"],
    ["analyses", "analysis"],
    ["indices", "index"],
    ["matrices", "matrix"],
    ["quizzes", "quiz"],
    ["news", "news"],
    ["series", "series"],
    ["boxes", "box"],
    ["lives", "life"],
    ["shelves", "shelf"],
    ["movies", "movie"],
    ["buses", "bus"],
    ["databases", "database"],
  ])("reads %s as %s", (plural, singular) => {
    expect(singularize(plural)).toBe(singular);
  });

  it.each(["sheep", "fish", "equipment", "police", "money"])(
    "leaves %s alone",
    (word) => {
      expect(singularize(word)).toBe(word);
    },
  );

  it("leaves a word already singular alone", () => {
    expect(singularize("account")).toBe("account");
  });
});

describe("camelize", () => {
  it.each([
    ["status", "Status"],
    ["media_attachment", "MediaAttachment"],
    ["a_b_c", "ABC"],
    ["_leading", "Leading"],
    ["double__underscore", "DoubleUnderscore"],
  ])("reads %s as %s", (word, camelized) => {
    expect(camelize(word)).toBe(camelized);
  });
});

describe("the class an association targets", () => {
  it("singularises a name written in the plural", () => {
    expect(associationTargetName("media_attachments", true)).toBe(
      "MediaAttachment",
    );
  });

  it("leaves a name written in the singular as it is", () => {
    expect(associationTargetName("account", false)).toBe("Account");
  });

  it("keeps an uncountable name whole", () => {
    expect(associationTargetName("sheep", true)).toBe("Sheep");
  });
});

describe("what the project taught its own inflector", () => {
  const PROJECT = {
    acronyms: ["API"],
    irregular: [["people", "person"]] as Array<[string, string]>,
    uncountable: ["equipment"],
    singular: [
      ["data", "data"],
      ["/(quiz)zes$/i", "\\1"],
    ] as Array<[string, string]>,
  };

  it("singularises an irregular the defaults spell another way", () => {
    expect(singularize("people")).toBe("person");
    expect(singularize("kine", PROJECT)).toBe("kine");
    expect(singularize("people", { irregular: [["people", "persona"]] })).toBe(
      "persona",
    );
  });

  it("keeps the case of the word it replaces, the way ActiveSupport does", () => {
    expect(singularize("Kine", { irregular: [["kine", "cow"]] })).toBe("Cow");
    expect(singularize("kine", { irregular: [["kine", "cow"]] })).toBe("cow");
  });

  it("keeps a word the project called uncountable", () => {
    expect(singularize("equipments", PROJECT)).toBe("equipment");
    expect(singularize("equipment", PROJECT)).toBe("equipment");
  });

  it("applies a rule written as a string and one written as a pattern", () => {
    expect(singularize("data", PROJECT)).toBe("data");
    expect(singularize("quizzes", PROJECT)).toBe("quiz");
  });

  it("keeps an acronym whole in the constant name", () => {
    expect(camelize("api_token", ["API"])).toBe("APIToken");
    expect(camelize("api_token")).toBe("ApiToken");
  });

  it("reaches a class only the project's own words spell", () => {
    expect(associationTargetName("people", true, PROJECT)).toBe("Person");
    expect(associationTargetName("api_tokens", true, PROJECT)).toBe("APIToken");
  });
});
