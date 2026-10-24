/**
 * Tells the Ruby adapter how ActiveJob runs a job later, and how
 * ActionMailer delivers a message through it. A job class's `perform`
 * and each public method of a mailer become consumers of an `activejob`
 * channel, and `perform_later` or `deliver_later` becomes a send to it.
 *
 * Every class and call listed here is one Rails defines. The README says
 * what the pack reads and what it leaves out.
 */

import { z } from "zod";

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

export const optionsSchema = z.object({}).strict();

export type ActiveJobPackOptions = z.infer<typeof optionsSchema>;

export function activeJobFramework(
  _options: ActiveJobPackOptions = {},
): RubyPack {
  return {
    name: "activejob",
    protocol: "activejob",
    discovery: [],
    jobs: [
      {
        type: "jobClasses",
        messageBus: "activejob",
        // A scaffolded app puts ApplicationJob in between. Listing it too
        // covers a run that does not read app/jobs/application_job.rb.
        baseClasses: ["ActiveJob::Base", "ApplicationJob"],
        modules: [],
        performMethod: "perform",
        enqueueMethods: { perform_later: 0, perform_now: 0 },
        optionMethods: ["set"],
        queueDeclarations: [{ call: "queue_as", queue: { at: 0 } }],
      },
      {
        type: "mailers",
        messageBus: "activejob",
        baseClasses: ["ActionMailer::Base", "ApplicationMailer"],
        // `deliver_later!` skips the checks that `deliver_later` runs first.
        enqueueMethods: ["deliver_later", "deliver_later!"],
        optionMethods: ["with"],
      },
    ],
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-activejob",
  // An app that depends on the Rails gems one at a time lists activejob.
  dependencies: [
    { ecosystem: "rubygems", name: "rails" },
    { ecosystem: "rubygems", name: "activejob" },
  ],
  reads:
    "ActiveJob jobs and ActionMailer messages (Ruby): each job's perform and each mailer method is a consumer of an activejob channel, and perform_later or deliver_later a send to it.",
};

export default activeJobFramework;
