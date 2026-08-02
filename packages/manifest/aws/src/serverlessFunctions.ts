// serverlessFunctions.ts — read AWS::Serverless::Function resources into
// a code-facing view: which module + export each function points at, and
// which route / non-route Events it declares.
//
// The summary-generation paths (index.ts) expand SAM Events into API
// Gateway route summaries. This reader answers the complementary
// question the code-side pairing needs: "given the template, where is
// each handler's implementation, and what routes is it bound to?" The
// manifest semantics (Handler string layout, CodeUri inheritance from
// Globals, Api vs HttpApi Events) stay owned here rather than being
// reconstructed inside a framework pack.

import { resourcesWithGlobals } from "./globals.js";
import { type CloudFormationTemplate, refTarget } from "./templateLoader.js";

/** A route-bearing SAM Event (`Type: Api` or `Type: HttpApi`). */
export interface ServerlessHttpRoute {
  /** Key of the event in the function's `Events` map. */
  eventId: string;
  /** "Api" (REST / API Gateway v1) or "HttpApi" (API Gateway v2). */
  eventType: "Api" | "HttpApi";
  /** HTTP method, uppercased. `"ANY"` for the catch-all. */
  method: string;
  /** Route path with `{param}` templating, verbatim from the template. */
  path: string;
  /** Logical id of the API resource the event targets, or null when implicit. */
  apiId: string | null;
}

/**
 * A recognized SAM Event that isn't an HTTP route — SQS / Schedule /
 * SNS / S3 / etc. Surfaced (not dropped) so the code side can account
 * for handlers it recognizes but deliberately doesn't extract as HTTP.
 */
export interface ServerlessNonHttpEvent {
  eventId: string;
  /** Event `Type` verbatim (e.g. "SQS", "Schedule", "SNS"). */
  eventType: string;
}

export interface ServerlessFunctionInfo {
  /** Logical id of the AWS::Serverless::Function resource. */
  logicalId: string;
  /** Raw Handler string, e.g. "src/handlers/confirmToken.handler". */
  handler: string;
  /** Module-path portion of the handler (everything before the final dot). */
  modulePath: string;
  /** Exported symbol the handler names (everything after the final dot). */
  exportName: string;
  /**
   * CodeUri base directory the handler resolves against: the function's
   * own CodeUri, else the `Globals.Function.CodeUri` default, else ".".
   */
  codeUri: string;
  httpRoutes: ServerlessHttpRoute[];
  nonHttpEvents: ServerlessNonHttpEvent[];
}

export interface ParsedHandler {
  modulePath: string;
  exportName: string;
}

/**
 * Split a SAM Handler string into its module path and exported symbol.
 * The final dot separates them: `"src/handlers/confirmToken.handler"` →
 * `{ modulePath: "src/handlers/confirmToken", exportName: "handler" }`.
 * Returns null when there's no dot (nothing names an export to bind to).
 */
export function parseHandler(handler: string): ParsedHandler | null {
  const trimmed = handler.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return null;
  }
  return {
    modulePath: trimmed.slice(0, lastDot),
    exportName: trimmed.slice(lastDot + 1),
  };
}

/** Strip a leading `./` and any trailing slash from a CodeUri directory. */
function normalizeCodeUri(raw: string): string {
  const trimmed = raw.replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed === "" ? "." : trimmed;
}

function readCodeUri(resource: {
  Properties?: Record<string, unknown>;
}): string {
  const codeUri = resource.Properties?.CodeUri;
  if (typeof codeUri === "string") {
    return normalizeCodeUri(codeUri);
  }
  return ".";
}

function classifyEvents(events: Record<string, unknown>): {
  httpRoutes: ServerlessHttpRoute[];
  nonHttpEvents: ServerlessNonHttpEvent[];
} {
  const httpRoutes: ServerlessHttpRoute[] = [];
  const nonHttpEvents: ServerlessNonHttpEvent[] = [];

  for (const [eventId, raw] of Object.entries(events)) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const event = raw as {
      Type?: unknown;
      Properties?: Record<string, unknown>;
    };
    const type = typeof event.Type === "string" ? event.Type : "";
    if (type === "") {
      continue;
    }
    if (type !== "Api" && type !== "HttpApi") {
      nonHttpEvents.push({ eventId, eventType: type });
      continue;
    }
    const props = event.Properties ?? {};
    const method = String(props.Method ?? "").toUpperCase();
    const path = String(props.Path ?? "");
    if (method === "" || path === "") {
      // A route event missing its method or path can't bind; record it
      // as a non-HTTP recognition so it still surfaces in accounting.
      nonHttpEvents.push({ eventId, eventType: type });
      continue;
    }
    const apiRef =
      type === "Api" ? refTarget(props.RestApiId) : refTarget(props.ApiId);
    httpRoutes.push({
      eventId,
      eventType: type,
      method,
      path,
      apiId: apiRef,
    });
  }

  return { httpRoutes, nonHttpEvents };
}

/**
 * Read every AWS::Serverless::Function resource in the template into a
 * code-facing `ServerlessFunctionInfo`. Functions without a parseable
 * Handler are skipped (there's no export to bind). Functions with no
 * Events still appear (empty route + non-route lists) so a consumer can
 * see them.
 */
export function readServerlessFunctions(
  template: CloudFormationTemplate,
): ServerlessFunctionInfo[] {
  const resources = resourcesWithGlobals(template);
  const out: ServerlessFunctionInfo[] = [];

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Serverless::Function") {
      continue;
    }
    const handlerRaw = resource.Properties?.Handler;
    if (typeof handlerRaw !== "string") {
      continue;
    }
    const parsed = parseHandler(handlerRaw);
    if (parsed === null) {
      continue;
    }

    const eventsRaw = resource.Properties?.Events;
    const events =
      eventsRaw !== null &&
      typeof eventsRaw === "object" &&
      !Array.isArray(eventsRaw)
        ? (eventsRaw as Record<string, unknown>)
        : {};
    const { httpRoutes, nonHttpEvents } = classifyEvents(events);

    out.push({
      logicalId,
      handler: handlerRaw,
      modulePath: parsed.modulePath,
      exportName: parsed.exportName,
      codeUri: readCodeUri(resource),
      httpRoutes,
      nonHttpEvents,
    });
  }

  return out;
}
