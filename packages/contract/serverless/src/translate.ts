// translate.ts: a Serverless Framework service, written as the
// CloudFormation resources it deploys.
//
// The framework compiles a serverless.yml into one CloudFormation
// stack: each function becomes a Lambda, each event becomes the
// resource that triggers it, and the `resources:` block is copied in
// as written. So the reader states the same thing in SAM's shapes and
// hands them to the CloudFormation reader, rather than growing a
// second set of summary builders that would drift from it.
//
// Two things map onto SAM directly enough to be worth naming:
//
//   provider.environment is SAM's `Globals.Function.Environment`. Both
//   supply a default every function in the document inherits and the
//   function's own block overrides, so the provenance a reader gets
//   back ("globals") is already the right claim: a variable written
//   once for the whole service says something about the service.
//
//   provider.runtime and the service's code directory are SAM's
//   `Globals.Function.Runtime` and `CodeUri`.
//
// A function's identity is the key it is written under. That key is
// what a person names when they deploy, invoke, or tail the function,
// and it is what the framework builds its own logical id out of.

import { EVENT_TRANSLATIONS, type SamEvent } from "./events.js";
import { createVariableResolver } from "./variables.js";

import type {
  CloudFormationResource,
  CloudFormationTemplate,
} from "@suss/manifest-aws";
import type { ServerlessDocument } from "./document.js";
import type { ResolvedValue } from "./variables.js";

/**
 * A wiring the document declares that this reader did not translate,
 * named so the caller can report it. Reading stopped here; nothing
 * about the service is claimed either way.
 */
export interface UnreadWiring {
  /** Function key the event is declared under, or null for a service-level abstention. */
  functionName: string | null;
  /** The event kind as the framework spells it, or the block name. */
  kind: string;
  reason: string;
}

export interface TranslatedService {
  /**
   * The functions block as SAM resources, with provider defaults in a
   * Globals section.
   */
  functions: CloudFormationTemplate;
  /** The `resources:` block verbatim, or null when the document has none. */
  resources: CloudFormationTemplate | null;
  unread: UnreadWiring[];
}

/**
 * The synthetic logical ids the two implicit APIs get. The framework
 * creates one HTTP API and one REST API per service and attaches every
 * route to it; the CloudFormation reader already uses these two names
 * for an API whose routes name no API resource, so a route from either
 * manifest language lands on the same one.
 */
const IMPLICIT_HTTP_API = "HttpApi";
const IMPLICIT_REST_API = "RestApi";

/** The event kinds that attach to the implicit APIs. */
const IMPLICIT_API_FOR_EVENT: Record<string, string> = {
  HttpApi: IMPLICIT_HTTP_API,
  Api: IMPLICIT_REST_API,
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
        events[`${kind}${index}`] = translated.event;
        const implicitApi = IMPLICIT_API_FOR_EVENT[translated.event.Type];
        if (implicitApi !== undefined) {
          implicitApis.add(implicitApi);
        }
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
 * The provider block as a SAM `Globals.Function` section: the runtime
 * every function inherits, the environment every function inherits,
 * and the directory the service's code is packaged from.
 *
 * The directory is the service root. The framework packages the whole
 * service into every function's artifact unless `package.individually`
 * narrows it per function, which this reader does not read; a service
 * that sets it gets a scope wider than what deploys.
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

/** A resolved value when the document states a string, else null. */
function statedString(resolved: ResolvedValue): string | null {
  return resolved.kind === "resolved" && typeof resolved.value === "string"
    ? resolved.value
    : null;
}

/**
 * An `environment` block with each value resolved as far as the
 * document states it. A value naming a deploy-time source keeps its
 * reference as a token: the variable is declared either way, and the
 * token says which binding would fill it in.
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
 * The `resources:` block as a CloudFormation template. The framework
 * copies these resources into the compiled stack, so the reader hands
 * them on rather than re-reading what CloudFormation means by them.
 *
 * Variables resolve first. The framework resolves its own variables
 * across the whole document before it compiles anything, so a property
 * written `${self:custom.tableName}` is a name by the time
 * CloudFormation sees it; handing the reference through as text would
 * report the reference itself as the property's value.
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
