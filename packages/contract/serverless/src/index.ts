/**
 * @suss/contract-serverless: behavioral summaries from a Serverless
 * Framework service file.
 *
 * This reader rewrites the service as SAM resources and passes them to
 * @suss/contract-cloudformation, so a service file and a SAM template
 * with the same wiring produce the same summaries.
 *
 * The functions block and the `resources:` block deploy into one stack
 * but are read as two documents, labelled `serverless:<file>` and
 * `serverless:<file>#resources` the way a nested stack is, so the flow
 * walk still scopes both to one service. The README maps each block to
 * what it becomes.
 */

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
  /**
   * Called once for each wiring the reader did not translate. Defaults to
   * printing a line on stderr.
   */
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

/**
 * Reads a service file and returns its summaries. The path may be the
 * service file itself or the directory it is in.
 */
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
