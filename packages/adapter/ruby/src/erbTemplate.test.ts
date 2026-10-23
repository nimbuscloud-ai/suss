import { describe, expect, it } from "vitest";

import { envReadEffects } from "./envReads.js";
import { rubyInErbTemplate } from "./erbTemplate.js";
import { parseRuby } from "./parser.js";

interface Read {
  name: string;
  defaulted: boolean;
}

async function templateReads(template: string): Promise<Read[]> {
  const tree = await parseRuby(rubyInErbTemplate(template));
  return envReadEffects(tree.rootNode).flatMap((effect) =>
    effect.type === "interaction" && effect.interaction.class === "config-read"
      ? [
          {
            name: effect.interaction.name,
            defaulted: effect.interaction.defaulted,
          },
        ]
      : [],
  );
}

describe("rubyInErbTemplate", () => {
  it("keeps every character's offset, so the code is on the template's lines", () => {
    const template = [
      "production:",
      "  url: <%= ENV['DATABASE_URL'] %>",
      "  pool: 5",
      "",
    ].join("\n");
    const ruby = rubyInErbTemplate(template);
    expect(ruby).toHaveLength(template.length);
    expect(ruby.split("\n")).toHaveLength(template.split("\n").length);
    expect(ruby.indexOf("ENV['DATABASE_URL']")).toBe(
      template.indexOf("ENV['DATABASE_URL']"),
    );
  });

  it("puts a printed value inside brackets and ends a code tag with a semicolon", () => {
    expect(rubyInErbTemplate("a: <%= x %>")).toBe("   [   x ];");
    expect(rubyInErbTemplate("<% if x %>")).toBe("   if x ; ");
  });

  it("drops the trim marks, and leaves a comment and a literal opening as text", () => {
    expect(rubyInErbTemplate("<%- y -%>")).toBe("    y  ; ");
    expect(rubyInErbTemplate("<%# ENV['X'] %>")).toBe(" ".repeat(15));
    expect(rubyInErbTemplate("<%% ENV['X'] %>")).toBe(" ".repeat(15));
  });

  it("runs nothing after a tag that never closes", () => {
    expect(rubyInErbTemplate("a: <%= ENV['X']\nb: 1")).toBe(
      `${" ".repeat(15)}\n${" ".repeat(4)}`,
    );
  });
});

describe("environment reads in an ERB template", () => {
  it("reads every variable the tags read, with the fallback each supplies", async () => {
    const reads = await templateReads(
      [
        "default: &default",
        '  pool: <%= ENV.fetch("RAILS_MAX_THREADS") { 5 } %>',
        "production:",
        "  url: <%= ENV['DATABASE_CONNECTION_POOL_URL'] || ENV['DATABASE_URL'] %>",
        '  redis: <%= ENV.fetch("REDIS_URL") %>',
        "",
      ].join("\n"),
    );
    expect(reads).toEqual([
      { name: "RAILS_MAX_THREADS", defaulted: true },
      { name: "DATABASE_CONNECTION_POOL_URL", defaulted: true },
      { name: "DATABASE_URL", defaulted: false },
      { name: "REDIS_URL", defaulted: false },
    ]);
  });

  it("reads a test written across two tags as a test", async () => {
    const reads = await templateReads(
      [
        '<% if ENV["READ_REPLICA_URL"] %>',
        "replica:",
        '  url: <%= ENV["READ_REPLICA_URL"] %>',
        "<% end %>",
        "",
      ].join("\n"),
    );
    expect(reads).toEqual([
      { name: "READ_REPLICA_URL", defaulted: true },
      { name: "READ_REPLICA_URL", defaulted: true },
    ]);
  });

  it("reads two tags on one line as two statements", async () => {
    const reads = await templateReads(
      'url: redis://<%= ENV["REDIS_HOST"] %>:<%= ENV["REDIS_PORT"] %>/0\n',
    );
    expect(reads.map((read) => read.name)).toEqual([
      "REDIS_HOST",
      "REDIS_PORT",
    ]);
  });
});
