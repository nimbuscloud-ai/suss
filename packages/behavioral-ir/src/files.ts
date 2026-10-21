/**
 * @suss/behavioral-ir/files: the one reader and writer for the JSON
 * files suss keeps on disk. It needs Node's file system, so it is a
 * separate entry point and the main one stays free of it.
 */

export {
  documentPieces,
  JsonFileError,
  type JsonFileIssue,
  type JsonFileProblem,
  readJsonFile,
  writeDocumentFile,
  writeFileAtomically,
} from "./documentFile.js";
export { readSummaryFile, writeSummaryFile } from "./summaryFile.js";
