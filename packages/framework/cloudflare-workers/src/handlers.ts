/**
 * The four triggers a Workers entrypoint can be invoked on, and the
 * boundary each one is.
 *
 * Cloudflare defines the names and what invokes each: `fetch` for an
 * HTTP request, `scheduled` for a cron trigger, `queue` for a batch off
 * a Cloudflare Queue, `tail` for another Worker's trace events. A
 * project chooses none of this, so the table is the pack's own
 * vocabulary rather than configuration. The README beside this file
 * says why `fetch` gets one boundary for the Worker.
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
 * A trigger reached over a wire with no producer is still a boundary,
 * and giving it the wire rather than the pack's http keeps it from
 * claiming to serve requests.
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
