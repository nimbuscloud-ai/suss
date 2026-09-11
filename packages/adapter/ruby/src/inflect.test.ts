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
