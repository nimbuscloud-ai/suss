/**
 * What a client call does with a redirect once the adapter has read the
 * value the call gives the pack's redirect option. Each adapter reads
 * the value in its own language, and all of them decide the same way.
 */

import type { RedirectDelivery, RedirectOption } from "./framework.js";

/** `"response"` when the value is one that hands the 3xx back, and `"followed"` otherwise. */
export function redirectDeliveryWhenSet(
  option: RedirectOption,
  value: string | number | boolean,
): RedirectDelivery {
  return option.handsBack.includes(value) ? "response" : "followed";
}
