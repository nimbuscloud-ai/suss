// The job values the ActiveJob and Sidekiq packs supply. The adapter's
// own source contains none of these strings.

import type { RubyPack } from "../pack.js";

export function activeJobTestPack(): RubyPack {
  return {
    name: "activejob",
    protocol: "activejob",
    discovery: [],
    jobs: [
      {
        type: "jobClasses",
        messageBus: "activejob",
        baseClasses: ["ActiveJob::Base", "ApplicationJob"],
        modules: [],
        performMethod: "perform",
        enqueueMethods: { perform_later: 0 },
        optionMethods: ["set"],
        queueDeclarations: [{ call: "queue_as", queue: { at: 0 } }],
      },
      {
        type: "mailers",
        messageBus: "activejob",
        baseClasses: ["ActionMailer::Base", "ApplicationMailer"],
        enqueueMethods: ["deliver_later"],
        optionMethods: ["with"],
      },
    ],
  };
}

export function sidekiqTestPack(): RubyPack {
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
        enqueueMethods: { perform_async: 0, perform_in: 1 },
        optionMethods: ["set"],
        queueDeclarations: [
          { call: "sidekiq_options", queue: { at: 0, keyword: "queue" } },
        ],
      },
    ],
  };
}
