import { describe, expect, it } from "vitest";

import { spellArgument } from "./argumentSpelling.js";

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
});
