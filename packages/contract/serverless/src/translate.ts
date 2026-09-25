/**
 * A Serverless Framework service, rewritten as the CloudFormation
 * resources it deploys, for the CloudFormation reader to summarize.
 *
 * `provider.environment` becomes SAM's `Globals.Function.Environment`.
 * Both give every function a default that its own block can override,
 * so an inherited variable gets `globals` provenance, which fits a
 * variable written once for the whole service. `provider.runtime` and
 * the service directory become `Globals.Function.Runtime` and `CodeUri`.
 *
 * A function's identity is the key it is written under. People type
 * that key to deploy, invoke or tail the function, and the framework
 * builds its logical id from it.
 */

import { EVENT_TRANSLATIONS, type SamEvent } from "./events.js";
import { createVariableResolver } from "./variables.js";

import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "@suss/manifest-aws";
import type { ServerlessDocument } from "./document.js";
import type { ResolvedValue } from "./variables.js";

/** A wiring the document declares that this reader did not translate. */
export interface UnreadWiring {
  /** Null when the wiring belongs to the whole service. */
  functionName: string | null;
  /** The event kind as the framework spells it, or the block name. */
  kind: string;
  reason: string;
}

export interface TranslatedService {
  /** The functions block as SAM resources, with provider defaults in Globals. */
  functions: CloudFormationTemplate;
  /** The `resources:` block verbatim, or null when the document has none. */
  resources: CloudFormationTemplate | null;
  unread: UnreadWiring[];
}

// The framework deploys one API of each kind per service. Each event
// states which one, because a SAM event that states none goes to the
// API that SAM itself would create.
const IMPLICIT_HTTP_API = "HttpApi";
const IMPLICIT_REST_API = "RestApi";

const IMPLICIT_API_FOR_EVENT: Record<
  string,
  { apiId: string; idProperty: string }
> = {
  HttpApi: { apiId: IMPLICIT_HTTP_API, idProperty: "ApiId" },
  Api: { apiId: IMPLICIT_REST_API, idProperty: "RestApiId" },
};

const IMPLICIT_API_TYPE: Record<string, string> = {
  [IMPLICIT_HTTP_API]: "AWS::Serverless::HttpApi",
  [IMPLICIT_REST_API]: "AWS::Serverless::Api",
};

export function translateService(
  document: ServerlessDocument,
): TranslatedService {
  const resolver = createVariableResolver(document as Record<string, unknown>);
  const unread: UnreadWiring[] = [];
  const resources: Record<string, CloudFormationResource> = {};
  const implicitApis = new Set<string>();

  if (document.plugins !== undefined) {
    unread.push({
      functionName: null,
      kind: "plugins",
      reason:
        "the service loads plugins, which can add, rename or rewrite functions and events; what they declare is not in this document",
    });
  }

  for (const [functionName, definition] of Object.entries(
    document.functions ?? {},
  )) {
    if (definition === null || typeof definition !== "object") {
      continue;
    }
    const handler = resolver.resolveValue(definition.handler);
    if (handler.kind !== "resolved" || typeof handler.value !== "string") {
      unread.push({
        functionName,
        kind: "handler",
        reason:
          "the function's handler is not a string this document states, so nothing names the code behind it",
      });
      continue;
    }

    const events: Record<string, SamEvent> = {};
    const declared = Array.isArray(definition.events) ? definition.events : [];
    for (const [index, entry] of declared.entries()) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      for (const [kind, raw] of Object.entries(
        entry as Record<string, unknown>,
      )) {
        const translate = EVENT_TRANSLATIONS[kind];
        if (translate === undefined) {
          unread.push({
            functionName,
            kind,
            reason: "this reader does not translate that event kind yet",
          });
          continue;
        }
        const translated = translate(raw, { resolver });
        if (translated.kind === "abstained") {
          unread.push({ functionName, kind, reason: translated.reason });
          continue;
        }
        const implicitApi = IMPLICIT_API_FOR_EVENT[translated.event.Type];
        if (implicitApi === undefined) {
          events[`${kind}${index}`] = translated.event;
          continue;
        }

        implicitApis.add(implicitApi.apiId);
        events[`${kind}${index}`] = {
          ...translated.event,
          Properties: {
            ...translated.event.Properties,
            [implicitApi.idProperty]: { Ref: implicitApi.apiId },
          },
        };
      }
    }

    const runtime = statedString(resolver.resolveValue(definition.runtime));
    resources[functionName] = {
      Type: "AWS::Serverless::Function",
      Properties: {
        Handler: handler.value,
        ...(runtime !== null ? { Runtime: runtime } : {}),
        ...(Object.keys(events).length > 0 ? { Events: events } : {}),
        Environment: {
          Variables: environmentVariables(definition.environment, resolver),
        },
      },
    };
  }

  for (const apiId of implicitApis) {
    resources[apiId] = { Type: IMPLICIT_API_TYPE[apiId], Properties: {} };
  }

  return {
    functions: {
      Globals: providerGlobals(document, resolver),
      Resources: resources,
    },
    resources: rawResources(document, resolver),
    unread,
  };
}

/**
 * `CodeUri` is the service root because this reader does not read
 * `package.individually`, which can narrow it per function.
 */
function providerGlobals(
  document: ServerlessDocument,
  resolver: ReturnType<typeof createVariableResolver>,
): Record<string, Record<string, unknown>> {
  const provider = document.provider ?? {};
  const runtime = statedString(resolver.resolveValue(provider.runtime));

  return {
    Function: {
      CodeUri: ".",
      ...(runtime !== null ? { Runtime: runtime } : {}),
      Environment: {
        Variables: environmentVariables(provider.environment, resolver),
      },
    },
  };
}

/** Null unless the document states a string. */
function statedString(resolved: ResolvedValue): string | null {
  return resolved.kind === "resolved" && typeof resolved.value === "string"
    ? resolved.value
    : null;
}

/**
 * Each value resolved as far as the document states it. A value that
 * points at a deploy-time source keeps its reference as a token, since
 * the variable is declared either way.
 */
function environmentVariables(
  raw: unknown,
  resolver: ReturnType<typeof createVariableResolver>,
): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const resolved = resolver.resolveValue(value);
    out[name] = resolved.kind === "resolved" ? resolved.value : resolved.token;
  }

  return out;
}

/**
 * The `resources:` block as a CloudFormation template. Variables
 * resolve first, the way the framework resolves its own across the
 * whole document before it compiles anything.
 */
function rawResources(
  document: ServerlessDocument,
  resolver: ReturnType<typeof createVariableResolver>,
): CloudFormationTemplate | null {
  const block = document.resources;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return null;
  }
  const declared = (block as { Resources?: unknown }).Resources;
  if (declared === null || typeof declared !== "object") {
    return null;
  }

  return {
    Resources: resolver.resolveTemplateTree(declared) as Record<
      string,
      CloudFormationResource
    >,
  };
}
