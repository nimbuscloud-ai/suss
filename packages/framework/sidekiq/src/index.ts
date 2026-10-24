/**
 * Tells the Ruby adapter how Sidekiq runs a job later. A class that
 * includes `Sidekiq::Job`, or its older name `Sidekiq::Worker`, has its
 * `perform` become a consumer of a `sidekiq` channel, and
 * `perform_async` or `perform_in` becomes a send to it.
 *
 * Every module and call listed here is one Sidekiq defines. The README
 * says what the pack reads and what it leaves out.
 */

import { z } from "zod";

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

export const optionsSchema = z.object({}).strict();

export type SidekiqPackOptions = z.infer<typeof optionsSchema>;

export function sidekiqFramework(_options: SidekiqPackOptions = {}): RubyPack {
  return {
    name: "sidekiq",
    protocol: "sidekiq",
    discovery: [],
    jobs: [
      {
        type: "jobClasses",
        messageBus: "sidekiq",
        baseClasses: [],
        modules: ["Sidekiq::Job", "Sidekiq::Worker"],
        performMethod: "perform",
        // `perform_in` and `perform_at` take the delay or the time first.
        enqueueMethods: { perform_async: 0, perform_in: 1, perform_at: 1 },
        optionMethods: ["set"],
        queueDeclarations: [
          { call: "sidekiq_options", queue: { at: 0, keyword: "queue" } },
        ],
      },
    ],
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-sidekiq",
  dependencies: [{ ecosystem: "rubygems", name: "sidekiq" }],
  reads:
    "Sidekiq jobs (Ruby): each job's perform is a consumer of a sidekiq channel, and perform_async, perform_in or perform_at a send to it.",
};

export default sidekiqFramework;
