// @suss/contract-serverless: behavioral summaries from a Serverless
// Framework service file.
//
// A serverless.yml deploys working functions, and before this reader
// existed suss saw none of them: no deployable unit, no environment
// contract, no event wiring. The functions block states the same facts
// a SAM template states, in the framework's own spelling, so this
// reader translates the spelling and hands the result to
// @suss/contract-cloudformation. Every boundary a service declares
// then comes out the way the same wiring comes out of a SAM template,
// and the two manifest languages cannot drift apart.
//
// What a service file says, and what this reader does with it:
//
//   provider        the runtime, and the environment every function
//                   inherits, read as SAM Globals. The region is read
//                   and left symbolic, since no boundary keys on it.
//   functions       one Lambda each, keyed by the name it is written
//                   under, with the handler saying where its code is.
//   events          httpApi and http become API Gateway routes; sqs,
//                   sns, schedule and eventBridge become the message
//                   bus wirings they compile to.
//   resources       raw CloudFormation, read by the CloudFormation
//                   reader as its own document.
//   custom          read only through `${self:custom...}` references.
//
// Two documents, one service. The functions block and the resources
// block deploy into a single stack, so a logical id means the same
// thing in both, and a queue declared in `resources:` is the queue an
// `sqs` event points at. They get different provenance labels
// (`serverless:<file>` and `serverless:<file>#resources`), built the
// way a nested stack's label is, so a reader can tell which block
// declared what while the flow walk still scopes both to one service.

import path from "node:path";

import { nestedDocumentLabel } from "@suss/behavioral-ir";
import {
  cloudFormationToSummaries,
  documentSourceLabel,
} from "@suss/contract-cloudformation";

import { loadServerlessDocument, locateServiceFile } from "./document.js";
import { translateService, type UnreadWiring } from "./translate.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ServerlessDocument } from "./document.js";

export {
  findServiceFile,
  loadServerlessDocument,
  locateServiceFile,
  PROGRAM_SERVICE_FILE_NAMES,
  SERVICE_FILE_NAMES,
  type ServerlessDocument,
  type ServerlessEvent,
  type ServerlessFunctionDefinition,
  type ServiceLocation,
} from "./document.js";
export { EVENT_TRANSLATIONS } from "./events.js";
export {
  type TranslatedService,
  translateService,
  type UnreadWiring,
} from "./translate.js";
export {
  createVariableResolver,
  type ResolvedString,
  type ResolvedValue,
  type VariableResolver,
} from "./variables.js";

/** The manifest language recorded on every binding this reader writes. */
const RECOGNITION = "serverless";

/** The stack-path segment in the raw CloudFormation block's label. */
const RESOURCES_DOCUMENT = "resources";

export interface ServerlessToSummariesOptions {
  /** Override the logical source file recorded on each summary. */
  source?: string;
  /** Called once per wiring the reader did not translate. Defaults to
   * printing a line on stderr. */
  onUnread?: (wiring: UnreadWiring) => void;
}

export function serverlessToSummaries(
  document: ServerlessDocument,
  options: ServerlessToSummariesOptions = {},
): BehavioralSummary[] {
  const translated = translateService(document);
  const report = options.onUnread ?? reportUnread;
  for (const wiring of translated.unread) {
    report(wiring);
  }

  const rootLabel = options.source ?? "serverless";
  const summaries = cloudFormationToSummaries(translated.functions, {
    source: rootLabel,
    recognition: RECOGNITION,
  });
  if (translated.resources === null) {
    return summaries;
  }

  return [
    ...summaries,
    ...cloudFormationToSummaries(translated.resources, {
      source: nestedDocumentLabel(rootLabel, [RESOURCES_DOCUMENT]),
      recognition: RECOGNITION,
    }),
  ];
}

/** The path may be the service file itself or the directory it is in. */
export function serverlessFileToSummaries(
  servicePath: string,
  options: ServerlessToSummariesOptions = {},
): BehavioralSummary[] {
  const located = locateServiceFile(servicePath);
  if (located.kind === "missing") {
    throw new Error(`Serverless service file not found: ${servicePath}`);
  }
  if (located.kind === "program") {
    const report = options.onUnread ?? reportUnread;
    report({
      functionName: null,
      kind: path.basename(located.file),
      reason:
        "a program declares this service, and a reader does not run one to find out what it says",
    });

    return [];
  }
  const document = loadServerlessDocument(located.file);

  return serverlessToSummaries(document, {
    ...options,
    source: options.source ?? documentSourceLabel("serverless", located.file),
  });
}

function reportUnread(wiring: UnreadWiring): void {
  const where =
    wiring.functionName === null
      ? wiring.kind
      : `${wiring.functionName}.${wiring.kind}`;
  process.stderr.write(`[suss] serverless: ${where}: ${wiring.reason}\n`);
}
