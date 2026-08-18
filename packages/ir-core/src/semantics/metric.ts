/**
 * A metric as a boundary: one side declares a named series of
 * measurements, the other side reads it back by that name.
 *
 * The name is the whole identity. A monitoring system gives a metric a
 * type string once it is deployed, an alert or a dashboard spells that
 * same string, and neither side can see the other's declaration, so the
 * string is all they share. What only the declaring side knows, whether
 * the measurements are a distribution or a single number, goes on its
 * summary's metadata instead.
 *
 * Reading a metric returns measurements rather than a status and a
 * body, so none of the HTTP-shaped checks apply.
 */

import { z } from "zod";

import { metricIdentityKey } from "../identityKeys.js";
import { defineBoundarySemantics } from "./definition.js";

export const MetricSemanticsSchema = z.object({
  name: z.literal("metric"),
  /** Which system the series lives in: cloud-monitoring, cloudwatch. */
  metricSystem: z.string(),
  /**
   * The type string the system knows the metric by, spelled the way
   * both sides spell it. Null when the source states one this reader
   * could not settle, as with a query it could not read: a metric
   * nobody could name pairs with nothing rather than with whatever
   * happens to share its source text.
   */
  metricType: z.string().nullable(),
});

export type MetricSemantics = z.infer<typeof MetricSemanticsSchema>;

export const metricSemantics = defineBoundarySemantics({
  name: "metric",
  schema: MetricSemanticsSchema,
  behavior: {
    exchangesHttpResponses: false,
    reportsUnpairedItself: false,
    identityKey(semantics) {
      if (semantics.metricType === null) {
        return null;
      }
      return metricIdentityKey(semantics.metricSystem, semantics.metricType);
    },
  },
});
