/**
 * The four triggers a Workers entrypoint can define, and the boundary
 * each one becomes. Cloudflare defines the names and what calls each:
 * `fetch` for an HTTP request, `scheduled` for a cron trigger, `queue`
 * for a batch from a Cloudflare Queue, `tail` for another Worker's trace
 * events. A project cannot change any of this, so the table is part of
 * the pack and has no option.
 *
 * The README explains why `fetch` gets one boundary for the whole Worker.
 */

import type { DiscoveredCustomUnit } from "@suss/extractor";

/** What the adapter needs to build one trigger's boundary binding. */
export interface TriggerShape {
  /** The IR code-unit kind a unit on this trigger takes. */
  kind: string;
  /** The rest binding, for the trigger that serves HTTP. */
  routeInfo?: DiscoveredCustomUnit["routeInfo"];
  /** The wire that delivers to this trigger, for the three that are not HTTP. */
  channelInfo?: DiscoveredCustomUnit["channelInfo"];
}

/**
 * Each trigger that is not HTTP gets its own wire, even a wire with no
 * producer, so it does not claim to serve requests under the pack's
 * http protocol.
 */
export const TRIGGERS: Record<string, TriggerShape> = {
  fetch: {
    kind: "handler",
    // A Worker serves whatever method reaches it, and the route it is
    // bound to is declared outside the code, so the path is null.
    routeInfo: { method: "*", path: null },
  },
  scheduled: {
    kind: "worker",
    channelInfo: { messageBus: "cloudflare-cron", channel: null },
  },
  queue: {
    kind: "consumer",
    channelInfo: { messageBus: "cloudflare-queues", channel: null },
  },
  tail: {
    kind: "consumer",
    channelInfo: { messageBus: "cloudflare-tail", channel: null },
  },
};
