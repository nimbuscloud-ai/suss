/**
 * The skill and the slash command are prompts the agent follows, so the
 * checks here are about what they tell it: that the example change list
 * is one suss accepts, and that each file has the frontmatter Claude
 * Code reads.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { parseChangeList } from "@suss/intent-ir";

const ROOT = path.resolve(__dirname, "..");

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return match === null ? {} : YAML.parse(match[1] ?? "");
}

function yamlBlocks(text: string): unknown[] {
  return [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((block) =>
    YAML.parse(block[1] ?? ""),
  );
}

describe("the intent skill", () => {
  const skill = read("skills/intent/SKILL.md");

  it("has the name and the description Claude Code picks it by", () => {
    expect(frontmatter(skill)).toMatchObject({
      name: "intent",
      description: expect.stringContaining("before the first edit"),
    });
  });

  it("shows a change list and an explained line suss accepts", () => {
    const [list, , explained] = yamlBlocks(skill);

    expect(parseChangeList(list).ok).toBe(true);
    expect(
      parseChangeList({ ...(list as object), ...(explained as object) }),
    ).toMatchObject({ ok: true, list: { explained: [{ verb: "changes" }] } });
  });

  it("spells an environment read as an effect on runtime-config, with the variable as a field", () => {
    const [, environment] = yamlBlocks(skill);

    expect(parseChangeList(environment)).toMatchObject({
      ok: true,
      list: {
        changes: [
          {
            verb: "adds",
            subject: {
              kind: "effect",
              effect: {
                does: "reads",
                names: "runtime-config",
                fields: ["ACCOUNTS_REGION"],
              },
            },
          },
        ],
      },
    });
  });

  it("points at the file the hooks read", () => {
    expect(skill).toContain(".suss/session/${CLAUDE_SESSION_ID}/intent.yaml");
  });
});

describe("the keep-intent command", () => {
  it("has a description and runs suss the way the hooks do", () => {
    const command = read("commands/keep-intent.md");

    expect(frontmatter(command).description).toEqual(expect.any(String));
    expect(command).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/keepIntent.mjs" --session "${CLAUDE_SESSION_ID}" --audience',
    );
  });
});
