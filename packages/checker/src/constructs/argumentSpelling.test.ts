import { describe, expect, it } from "vitest";

import { literalOf, spellArgument, spellLiteral } from "./argumentSpelling.js";

describe("spellLiteral", () => {
  it("spells a default the way a caller that wrote the same value is spelled", () => {
    expect(spellLiteral("get", "app/http.rb")).toBe(
      spellArgument({ kind: "string", value: "get" }, "app/grants.rb").blanked,
    );
    expect(spellLiteral(null, "app/http.rb")).toBe("nil");
    expect(spellLiteral(null, "app/http.py")).toBe("None");
    expect(spellLiteral(10, "a.ts")).toBe("10");
    expect(spellLiteral(false, "a.ts")).toBe("false");
  });

  it("reads a literal back out of an argument, and nothing out of a computed one", () => {
    expect(literalOf({ kind: "string", value: "post" })).toBe("post");
    expect(literalOf({ kind: "null" })).toBeNull();
    expect(literalOf({ kind: "identifier", name: "verb" })).toBeUndefined();
    expect(literalOf(null)).toBeUndefined();
  });
});

describe("spellArgument", () => {
  it("keeps the fixed parts of a Ruby interpolated string and blanks each hole", () => {
    expect(
      spellArgument(
        { kind: "identifier", name: '"user:#{@story.user.id}:posts"' },
        "app/models/story.rb",
      ),
    ).toEqual({
      spelled: '"user:#{@story.user.id}:posts"',
      blanked: '"user:#{_}:posts"',
    });
  });

  it("gives two keys with different values in the same hole the same blank", () => {
    const one = spellArgument(
      { kind: "template", sourceText: "`user:${req.params.id}:theme`" },
      "src/app.ts",
    );
    const other = spellArgument(
      { kind: "template", sourceText: "`user:${user.id}:theme`" },
      "src/app.ts",
    );
    expect(one.blanked).toBe(other.blanked);
    expect(one.spelled).not.toBe(other.spelled);
  });

  it("reads a Python f-string's holes and leaves a doubled brace alone", () => {
    expect(
      spellArgument(
        { kind: "identifier", name: 'f"{{raw}}:{user_id}"' },
        "app/main.py",
      ).blanked,
    ).toBe('f"{{raw}}:{_}"');
  });

  it("blanks a hole whose expression has braces of its own", () => {
    expect(
      spellArgument(
        { kind: "template", sourceText: "`a:${fn({ x: 1 })}:b`" },
        "src/a.ts",
      ).blanked,
    ).toBe("`a:${_}:b`");
  });

  it("treats a name, a call or an unreadable argument as computed as a whole", () => {
    for (const argument of [
      { kind: "identifier" as const, name: "user_in.email" },
      { kind: "call" as const, callee: "key_for", args: [] },
      null,
    ]) {
      expect(spellArgument(argument, "app/crud.py").blanked).toBe("_");
    }
  });

  it("spells a null the caller wrote the way the caller's language does", () => {
    expect(spellArgument({ kind: "null" }, "app/a.rb").spelled).toBe("nil");
    expect(spellArgument({ kind: "null" }, "app/a.py").spelled).toBe("None");
    expect(spellArgument({ kind: "null" }, "src/a.ts").spelled).toBe("null");
  });

  it("spells literals, objects and arrays as written", () => {
    expect(spellArgument({ kind: "string", value: "on" }, "a.ts").spelled).toBe(
      '"on"',
    );
    expect(spellArgument({ kind: "number", value: 3 }, "a.ts").spelled).toBe(
      "3",
    );
    expect(
      spellArgument({ kind: "boolean", value: false }, "a.ts").spelled,
    ).toBe("false");
    expect(spellArgument({ kind: "undefined" }, "a.ts").spelled).toBe(
      "undefined",
    );
    expect(
      spellArgument(
        {
          kind: "object",
          fields: { key: { kind: "identifier", name: "k" } },
        },
        "a.ts",
      ),
    ).toEqual({ spelled: "{key: k}", blanked: "{key: _}" });
    expect(
      spellArgument(
        { kind: "array", items: [{ kind: "string", value: "a" }] },
        "a.ts",
      ),
    ).toEqual({ spelled: '["a"]', blanked: '["a"]' });
  });

  it("spells keyword arguments the way each language writes them", () => {
    const keywords = {
      kind: "keywords" as const,
      fields: { verb: { kind: "string" as const, value: "post" } },
    };
    expect(spellArgument(keywords, "app/grants.rb").spelled).toBe(
      'verb: "post"',
    );
    expect(spellArgument(keywords, "app/grants.py").spelled).toBe(
      'verb="post"',
    );
  });
});
