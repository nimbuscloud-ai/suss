/**
 * A metric as a boundary: one side declares a named series of
 * measurements, and the other side reads it back by that name.
 *
 * The name is the whole identity. A monitoring system gives a deployed
 * metric a type string, and an alert or a dashboard writes the same
 * string. Neither side can see the other's declaration, so that string
 * is all they share. Whether the measurements are a distribution or a
 * single number is known only to the declaring side, so it goes in that
 * side's summary metadata.
 *
 * Reading a metric returns measurements, so the HTTP-style checks do
 * not apply.
 */

import { z } from "zod";

import { metricIdentityKey } from "../identityKeys.js";
import { defineBoundarySemantics } from "./definition.js";

export const MetricSemanticsSchema = z.object({
  name: z.literal("metric"),
  /** The system the series is stored in, such as `cloud-monitoring` or `cloudwatch`. */
  metricSystem: z.string(),
  /**
   * The type string the system uses for the metric, written the same
   * way on both sides. Null when the reader could not work the string
   * out, as with a query it could not parse. A null type pairs with
   * nothing, so it cannot pair with an unrelated metric that happens to
   * share its source text.
   */
  metricType: z.string().nullable(),
});

export type MetricSemantics = z.infer<typeof MetricSemanticsSchema>;

export const metricSemantics = defineBoundarySemantics({
  name: "metric",
  schema: MetricSemanticsSchema,
  // OpenTelemetry identifies a metric by its instrument name. It has no
  // attribute for the metric's system or its type string.
  semconv: {},
  behavior: {
    exchangesHttpResponses: false,
    leavesTheProcess: true,
    reportsUnpairedItself: false,
    identityKey(semantics) {
      if (semantics.metricType === null) {
        return null;
      }
      return metricIdentityKey(semantics.metricSystem, semantics.metricType);
    },
  },
});
