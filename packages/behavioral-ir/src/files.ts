/**
 * @suss/behavioral-ir/files: the one reader and writer for the JSON
 * files suss keeps on disk, the one way a summary spells a path on
 * disk, and which files on disk are test code. All of them need Node's
 * file system, so they are a separate entry point and the main one
 * stays free of it.
 */

export {
  documentPieces,
  JsonFileError,
  type JsonFileIssue,
  type JsonFileProblem,
  readJsonFile,
  type TextRewrite,
  writeDocumentFile,
  writeFileAtomically,
} from "./documentFile.js";
export {
  defaultProjectRoot,
  documentSourceLabel,
  namedPackageDirAbove,
  packageNameAt,
  pathInProject,
  projectNameOf,
} from "./projectPath.js";
export {
  isTestFileIn,
  readTestFilesFrom,
  testFilesUnder,
} from "./projectTestFiles.js";
export {
  readSummaryFile,
  summaryFilePieces,
  writeSummaryFile,
} from "./summaryFile.js";
