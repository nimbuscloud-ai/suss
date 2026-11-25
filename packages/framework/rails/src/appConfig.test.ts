import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { preloadRubyGrammar } from "@suss/adapter-ruby";

import { configuredBeside } from "./appConfig.js";

beforeAll(async () => {
  await preloadRubyGrammar();
});

/** A Rails root with these files under `config/`, and what its configuration covers. */
function besideOf(files: Record<string, string[]>): [string, string][] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rails-config-"));
  for (const [file, lines] of Object.entries(files)) {
    const at = path.join(root, "config", file);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, [...lines, ""].join("\n"));
  }
  return configuredBeside(root, (file) => path.relative(root, file)).map(
    (entry) => {
      expect(entry.path).toBeUndefined();
      return [entry.file, entry.written ?? ""];
    },
  );
}

describe("what a Rails app's configuration hands to code suss does not read", () => {
  it("covers every path for Bundler.require in application.rb and for middleware added anywhere under config", () => {
    expect(
      besideOf({
        "application.rb": [
          'require "rails"',
          "",
          "Bundler.require(*Rails.groups)",
          "",
          "module Shop",
          "  class Application < Rails::Application",
          "    config.middleware.insert_before 0, Rack::Attack",
          "  end",
          "end",
        ],
        "initializers/legacy.rb": [
          "Rails.application.config.middleware.use LegacySummary",
        ],
        "environments/production.rb": [
          "Rails.application.configure do",
          "  config.middleware.swap ActionDispatch::Static, Rack::Static",
          "end",
        ],
      }),
    ).toEqual([
      [
        "config/application.rb",
        "Bundler.require: gems loaded here can add routes and middleware",
      ],
      [
        "config/application.rb",
        "config.middleware.insert_before: middleware suss does not read",
      ],
      [
        "config/environments/production.rb",
        "config.middleware.swap: middleware suss does not read",
      ],
      [
        "config/initializers/legacy.rb",
        "Rails.application.config.middleware.use: middleware suss does not read",
      ],
    ]);
  });

  it("covers nothing for a config that loads no gems and adds no middleware", () => {
    expect(
      besideOf({
        "application.rb": [
          'require "rails"',
          "",
          "module Shop",
          "  class Application < Rails::Application",
          "    config.time_zone = 'UTC'",
          "  end",
          "end",
        ],
        "initializers/bundled.rb": ["Bundler.require(:tools)"],
      }),
    ).toEqual([]);
  });

  it("covers nothing for an app with no config directory", () => {
    expect(
      configuredBeside(
        fs.mkdtempSync(path.join(os.tmpdir(), "rails-")),
        (f) => f,
      ),
    ).toEqual([]);
  });
});
