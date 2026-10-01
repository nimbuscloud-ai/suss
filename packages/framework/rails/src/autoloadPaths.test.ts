import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readAutoloadRoots } from "./autoloadPaths.js";

function projectWith(application: string | null, directories: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rails-autoload-"));
  fs.mkdirSync(path.join(dir, "config"));
  for (const directory of directories) {
    fs.mkdirSync(path.join(dir, directory), { recursive: true });
  }
  if (application !== null) {
    fs.writeFileSync(path.join(dir, "config", "application.rb"), application);
  }
  return dir;
}

describe("readAutoloadRoots", () => {
  it("reads the directories config/application.rb adds, each spelling, in order", () => {
    const dir = projectWith(
      [
        "module Shop",
        "  class Application < Rails::Application",
        "    config.eager_load_paths << Rails.root.join('lib')",
        "    config.eager_load_paths << Rails.root.join('extra', 'lib')",
        "    config.autoload_paths += %W[#{config.root}/services]",
        "    # config.autoload_paths << Rails.root.join('commented')",
        '    config.eager_load_paths += Dir["#{Rails.root}/plugins/*"]',
        "  end",
        "end",
      ].join("\n"),
      ["lib", "extra/lib", "services", "commented"],
    );

    expect(readAutoloadRoots(dir)).toEqual([
      path.join(dir, "lib"),
      path.join(dir, "extra/lib"),
      path.join(dir, "services"),
    ]);
  });

  it("reads autoload_lib as lib", () => {
    const dir = projectWith("config.autoload_lib(ignore: %w[assets tasks])\n", [
      "lib",
    ]);
    expect(readAutoloadRoots(dir)).toEqual([path.join(dir, "lib")]);
  });

  it("leaves out a directory that is not there, and a project with no application.rb", () => {
    expect(
      readAutoloadRoots(
        projectWith("config.eager_load_paths << Rails.root.join('gone')\n", []),
      ),
    ).toEqual([]);
    expect(readAutoloadRoots(projectWith(null, []))).toEqual([]);
  });
});
