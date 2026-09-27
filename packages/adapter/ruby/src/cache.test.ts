/**
 * The on-disk extraction cache, exercised against a temp directory.
 *
 * Running under vitest gives the adapter a "source" code stamp, and a
 * run from source always declines to cache. `./version.js` is mocked
 * here so `adapterStamp.declineWhenRunFromSource` passes `cacheDir`
 * through unchanged. That is what puts the cache layer itself under
 * test, the same one a built CLI run reaches.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./version.js")>();
  return {
    ...actual,
    adapterStamp: {
      ...actual.adapterStamp,
      declineWhenRunFromSource: (cacheDir: string | null) => cacheDir,
    },
  };
});

import { graphqlRubyTestPack } from "./__fixtures__/graphqlRubyPattern.js";
import { railsTestPack } from "./__fixtures__/railsControllerPattern.js";
import { extractRubyProject, findRubyFiles } from "./project.js";

import type { CacheDiagnostic } from "@suss/extractor";
import type { RubyPack } from "./pack.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-ruby-cache-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function schemaProject(): string[] {
  write(
    "app/graphql/types/campaign_type.rb",
    "class Types::CampaignType < Types::BaseObject\n  field :id, ID, null: false\nend\n",
  );
  return findRubyFiles(tmpDir);
}

function testPacks(): RubyPack[] {
  return [graphqlRubyTestPack({ root: path.join(tmpDir, "app", "graphql") })];
}

describe("extractRubyProject's on-disk cache", () => {
  it("misses the first run and hits the second over unchanged files", async () => {
    const files = schemaProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    const first = await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    const second = await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(first.summaries.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.kind).toBe("miss");
    expect(diagnostics[1]).toEqual({ kind: "hit" });
    expect(second.summaries).toEqual(first.summaries);
  });

  it("re-extracts the one file whose content changed and replays the rest", async () => {
    const files = schemaProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    write(
      "app/graphql/types/campaign_type.rb",
      "class Types::CampaignType < Types::BaseObject\n  field :id, ID, null: false\n  field :name, String, null: false\nend\n",
    );
    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({
      kind: "partial",
      partial: {
        filesChanged: 1,
        filesRemoved: 0,
        rootsReused: 0,
        rootsReextracted: 1,
        rootsDeclined: 0,
        summariesReused: 0,
      },
    });
  });

  it("starts over when a file is added, since a new file can change which definition a name binds", async () => {
    const files = schemaProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    write(
      "app/graphql/types/organizer_type.rb",
      "class Types::OrganizerType < Types::BaseObject\n  field :id, ID, null: false\nend\n",
    );
    await extractRubyProject({
      files: findRubyFiles(tmpDir),
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]?.kind).toBe("miss");
  });

  it("misses with key-changed once a pack's declared version changes", async () => {
    const files = schemaProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    await extractRubyProject({
      files,
      packs: [{ ...packs[0], version: "2" }],
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  it("misses with key-changed once a file a pack reads without walking changes", async () => {
    const files = schemaProject();
    const routes = write("config/routes.rb", "get 'a', to: 'a#show'\n");
    const packs = testPacks().map((pack) => ({
      ...pack,
      discoveryInputs: () => [routes],
    }));
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    fs.writeFileSync(routes, "get 'b', to: 'b#show'\n");
    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  it("misses with key-changed once the gap setting changes", async () => {
    const files = schemaProject();
    const packs = testPacks();
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      onCacheDiagnostic,
    });
    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      gapHandling: "silent",
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  it("misses with key-changed once the directory ids are measured from changes", async () => {
    const files = schemaProject();
    const packs = testPacks();
    const cacheDir = path.join(tmpDir, ".suss", "cache");
    const diagnostics: CacheDiagnostic[] = [];
    const onCacheDiagnostic = (d: CacheDiagnostic) => diagnostics.push(d);

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      cacheDir,
      onCacheDiagnostic,
    });
    await extractRubyProject({
      files,
      packs,
      projectRoot: path.join(tmpDir, "app"),
      cacheDir,
      onCacheDiagnostic,
    });

    expect(diagnostics[1]).toEqual({ kind: "miss", missReason: "key-changed" });
  });

  describe("a run that replays part of the entry", () => {
    const storagePack: RubyPack = {
      name: "activerecord",
      protocol: "postgresql",
      discovery: [],
      storage: [
        {
          baseClasses: ["ApplicationRecord"],
          writes: ["save", "update"],
          reads: ["where", "find", "all"],
          givesBack: ["find"],
          storageSystem: "postgresql",
        },
      ],
    };

    function shopProject(): { files: () => string[]; packs: RubyPack[] } {
      write(
        "app/models/application_record.rb",
        "class ApplicationRecord\nend\n",
      );
      write(
        "app/models/order.rb",
        "class Order < ApplicationRecord\n  def open?\n    status == 'open'\n  end\nend\n",
      );
      write("app/models/item.rb", "class Item < ApplicationRecord\nend\n");
      write(
        "app/controllers/application_controller.rb",
        "class ApplicationController\n  def current_order\n    Order.find(params[:order_id])\n  end\nend\n",
      );
      write(
        "app/controllers/orders_controller.rb",
        "class OrdersController < ApplicationController\n  def index\n    Order.where(open: true)\n  end\n\n  def show\n    current_order\n  end\nend\n",
      );
      write(
        "app/controllers/items_controller.rb",
        "class ItemsController < ApplicationController\n  def index\n    Item.all\n  end\nend\n",
      );
      write(
        "app/controllers/shop/reports_controller.rb",
        "module Shop\n  class ReportsController < ApplicationController\n    def index\n      Order.where(open: true)\n    end\n  end\nend\n",
      );
      const packs: RubyPack[] = [
        railsTestPack({
          root: path.join(tmpDir, "app", "controllers"),
          routeFor: (controller, action) => ({
            method: "GET",
            path: `/${controller}/${action}`,
          }),
        }),
        storagePack,
      ];
      return { files: () => findRubyFiles(tmpDir), packs };
    }

    /** A cached run and a run without the cache over the same files, each as the JSON the CLI would write. */
    async function bothRuns(
      files: string[],
      packs: RubyPack[],
      diagnostics: CacheDiagnostic[],
    ): Promise<{ cached: string; cold: string }> {
      const cached = await extractRubyProject({
        files,
        packs,
        projectRoot: tmpDir,
        onCacheDiagnostic: (d) => diagnostics.push(d),
      });
      const cold = await extractRubyProject({
        files,
        packs,
        projectRoot: tmpDir,
        cacheDir: null,
      });
      return {
        cached: JSON.stringify(cached.summaries),
        cold: JSON.stringify(cold.summaries),
      };
    }

    it("gives what a run without the cache gives after a branch is added inside an action", async () => {
      const { files, packs } = shopProject();
      const diagnostics: CacheDiagnostic[] = [];
      await bothRuns(files(), packs, diagnostics);
      write(
        "app/controllers/orders_controller.rb",
        "class OrdersController < ApplicationController\n  def index\n    return Order.all if params[:all]\n    Order.where(open: true)\n  end\n\n  def show\n    current_order\n  end\nend\n",
      );

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
      expect(diagnostics[1]?.partial?.rootsReextracted).toBe(1);
    });

    it("gives what a run without the cache gives after a definition in another file shadows a name", async () => {
      const { files, packs } = shopProject();
      const diagnostics: CacheDiagnostic[] = [];
      const before = await bothRuns(files(), packs, diagnostics);
      write(
        "app/models/item.rb",
        "class Item < ApplicationRecord\nend\n\nmodule Shop\n  class Order\n  end\nend\n",
      );

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(cold).not.toBe(before.cold);
      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
    });

    it("gives what a run without the cache gives after a second assignment leaves a constant unbound", async () => {
      const { files, packs } = shopProject();
      write("app/models/limits.rb", "PageSize = 20\n");
      write(
        "app/controllers/items_controller.rb",
        "class ItemsController < ApplicationController\n  def index\n    Item.where(size: PageSize)\n  end\nend\n",
      );
      write("app/models/defaults.rb", "class Defaults\nend\n");
      const diagnostics: CacheDiagnostic[] = [];
      await bothRuns(files(), packs, diagnostics);
      write("app/models/defaults.rb", "class Defaults\nend\n\nPageSize = 50\n");

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
    });

    it("gives what a run without the cache gives after another file defines the top-level method a bare call names", async () => {
      const { files, packs } = shopProject();
      write(
        "app/controllers/items_controller.rb",
        "class ItemsController < ApplicationController\n  def index\n    audit_log\n    Item.all\n  end\nend\n",
      );
      write("app/lib/logging.rb", "def unrelated\n  1\nend\n");
      const diagnostics: CacheDiagnostic[] = [];
      const before = await bothRuns(files(), packs, diagnostics);
      write(
        "app/lib/logging.rb",
        "def unrelated\n  1\nend\n\ndef audit_log\n  Order.where(logged: true)\nend\n",
      );

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(cold).not.toBe(before.cold);
      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
    });

    it("gives what a run without the cache gives after an edit to a model every controller reads", async () => {
      const { files, packs } = shopProject();
      const diagnostics: CacheDiagnostic[] = [];
      await bothRuns(files(), packs, diagnostics);
      write(
        "app/models/order.rb",
        "class Order < ApplicationRecord\n  def open?\n    return false if archived?\n    status == 'open'\n  end\nend\n",
      );

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
    });

    /** Two controllers, both of which may inherit a filter from the base, so the first one claims its unit. */
    function filteredProject(firstInherits: boolean): {
      files: () => string[];
      packs: RubyPack[];
    } {
      const { files, packs } = shopProject();
      write(
        "app/controllers/application_controller.rb",
        "class ApplicationController\n  before_action :authenticate\n\n  private\n\n  def authenticate\n    Order.find(1)\n  end\nend\n",
      );
      writeAccounts(firstInherits);
      write(
        "app/controllers/billing_controller.rb",
        "class BillingController < ApplicationController\n  def index\n    Order.all\n  end\nend\n",
      );
      const withFilters: RubyPack[] = [
        railsTestPack({
          root: path.join(tmpDir, "app", "controllers"),
          routeFor: (controller, action) => ({
            method: "GET",
            path: `/${controller}/${action}`,
          }),
          filters: [{ name: "before_action", methodFrom: "argument" }],
        }),
        ...packs.slice(1),
      ];
      return { files, packs: withFilters };
    }

    function writeAccounts(inherits: boolean): void {
      write(
        "app/controllers/accounts_controller.rb",
        `class AccountsController < ${inherits ? "ApplicationController" : "ActionController::Base"}\n  def index\n    Item.all\n  end\nend\n`,
      );
    }

    it("discovers a later file again when an earlier one stops claiming a unit it shared", async () => {
      const { files, packs } = filteredProject(true);
      const diagnostics: CacheDiagnostic[] = [];
      const before = await bothRuns(files(), packs, diagnostics);
      writeAccounts(false);

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(cold).not.toBe(before.cold);
      expect(cached).toBe(cold);
      expect(diagnostics[1]?.partial?.rootsReextracted).toBe(2);
    });

    it("drops a unit from a replayed file when an earlier file starts claiming it", async () => {
      const { files, packs } = filteredProject(false);
      const diagnostics: CacheDiagnostic[] = [];
      const before = await bothRuns(files(), packs, diagnostics);
      writeAccounts(true);

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(cold).not.toBe(before.cold);
      expect(cached).toBe(cold);
      expect(diagnostics[1]?.kind).toBe("partial");
    });

    it("gives what a run without the cache gives after a helper that reads the environment changes", async () => {
      const { files, packs } = shopProject();
      write(
        "app/lib/settings.rb",
        "def setting(name)\n  ENV.fetch(name)\nend\n",
      );
      write(
        "app/controllers/items_controller.rb",
        'class ItemsController < ApplicationController\n  def index\n    setting("PAGE_SIZE")\n    Item.all\n  end\nend\n',
      );
      const diagnostics: CacheDiagnostic[] = [];
      await bothRuns(files(), packs, diagnostics);
      write(
        "app/controllers/orders_controller.rb",
        "class OrdersController < ApplicationController\n  def index\n    Order.all\n  end\nend\n",
      );
      const unrelated = await bothRuns(files(), packs, diagnostics);
      write(
        "app/lib/settings.rb",
        'def setting(name)\n  ENV.fetch(name, "10")\nend\n',
      );

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(unrelated.cached).toBe(unrelated.cold);
      expect(cold).not.toBe(unrelated.cold);
      expect(cached).toBe(cold);
    });

    it("gives what a run without the cache gives after the names a class defines at load time change", async () => {
      const { files, packs } = shopProject();
      const dynamicOrder = (states: string) =>
        `class Order < ApplicationRecord\n  %w[${states}].each do |state|\n    define_method("#{state}?") { status == state }\n  end\nend\n`;
      write("app/models/order.rb", dynamicOrder("open closed"));
      write(
        "app/controllers/orders_controller.rb",
        "class OrdersController < ApplicationController\n  def index\n    order = Order.find(1)\n    order.archived?\n    items.each(&method(:show_item))\n  end\n\n  def show_item(item)\n    item\n  end\nend\n",
      );
      const diagnostics: CacheDiagnostic[] = [];
      await bothRuns(files(), packs, diagnostics);
      write(
        "app/controllers/items_controller.rb",
        "class ItemsController < ApplicationController\n  def index\n    Item.where(open: true)\n  end\nend\n",
      );
      const unrelated = await bothRuns(files(), packs, diagnostics);
      write("app/models/order.rb", dynamicOrder("open closed archived"));

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(unrelated.cached).toBe(unrelated.cold);
      expect(cached).toBe(cold);
    });

    /** The entry the runs so far wrote, to change by hand. */
    function manifestPath(): string {
      const cacheDir = path.join(tmpDir, ".suss", "cache");
      const entry = fs
        .readdirSync(cacheDir)
        .find((name) => name.startsWith("key-")) as string;
      return path.join(cacheDir, entry, "manifest.json");
    }

    it.each([
      ["a method the walk followed", "walked"],
      ["a method a unit starts from", "seed"],
    ])(
      "starts over when %s is no longer where the entry says",
      async (_what, part) => {
        const { files, packs } = shopProject();
        const diagnostics: CacheDiagnostic[] = [];
        await bothRuns(files(), packs, diagnostics);
        const file = manifestPath();
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        const moved = new Set<string>();
        for (const meta of manifest.rootMeta) {
          for (const unit of part === "seed" ? meta.meta.units : []) {
            if (unit.seed !== undefined) {
              moved.add(unit.seed.key);
              unit.seed.key = `${unit.seed.key}9`;
            }
          }
        }
        for (const meta of manifest.rootMeta) {
          for (const walk of meta.meta.walked) {
            for (const target of part === "walked" ? walk.scan.followed : []) {
              target.key = `${target.key}9`;
            }
            // The walk record moves with the seed, so the record still replays.
            if (moved.has(walk.key)) {
              walk.key = `${walk.key}9`;
            }
          }
        }
        fs.writeFileSync(file, JSON.stringify(manifest));
        write(
          "app/controllers/items_controller.rb",
          "class ItemsController < ApplicationController\n  def index\n    Item.where(open: true)\n  end\nend\n",
        );

        const { cached, cold } = await bothRuns(files(), packs, diagnostics);

        expect(cached).toBe(cold);
        expect(diagnostics[1]).toEqual({
          kind: "miss",
          missReason: "files-changed",
        });
      },
    );

    it("hits after a file is written again with the same content", async () => {
      const { files, packs } = shopProject();
      const diagnostics: CacheDiagnostic[] = [];
      await bothRuns(files(), packs, diagnostics);
      const order = path.join(tmpDir, "app", "models", "order.rb");
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(order, later, later);

      const { cached, cold } = await bothRuns(files(), packs, diagnostics);

      expect(cached).toBe(cold);
      expect(diagnostics[1]).toEqual({ kind: "hit" });
    });
  });

  it("never writes an entry when cacheDir is null", async () => {
    const files = schemaProject();
    const packs = testPacks();

    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      cacheDir: null,
    });
    await extractRubyProject({
      files,
      packs,
      projectRoot: tmpDir,
      cacheDir: null,
    });

    expect(fs.existsSync(path.join(tmpDir, ".suss", "cache"))).toBe(false);
  });
});
