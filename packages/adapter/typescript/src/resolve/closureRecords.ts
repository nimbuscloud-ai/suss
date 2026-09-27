/**
 * What the reachable closure keeps between runs.
 *
 * Scanning a body for its calls costs a walk and a type checker question
 * per call. So each scan's findings go into the cache manifest as a unit
 * record: the calls, the gaps, where each callee is declared, and the
 * files the findings rest on. A later partial run takes the record in
 * place of the scan while the body's file and each of those files hash
 * the same. A body in an edited file has new offsets, so its key is new
 * and it is always scanned. The files a record rests on are the ones the
 * scan read, the files its callees and declarations are in, and the files
 * the body's own file imports, the bar a walked file is held to.
 */

import {
  fileOfOffsetKey,
  offsetKeyFor,
  spanOfOffsetKey,
} from "../walk/nodeKeys.js";

import type { DeclaredAt, UnfollowedCall } from "@suss/behavioral-ir";
import type { UnitRecord } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ReferenceIndex } from "../referencedFiles.js";

/** What one scan found, whether it ran on this run or came from a record. */
export interface ScanFindings {
  calls: ReadonlyArray<{ key: string; name: string; func?: FunctionRoot }>;
  stops: UnfollowedCall[];
  targets: ReadonlyMap<string, DeclaredAt>;
  argTargets: ReadonlyMap<string, ReadonlyMap<number, DeclaredAt>>;
  parameterCalls: ReadonlyArray<{ callee: string; parameterIndex: number }>;
  passedPositions: ReadonlySet<string>;
}

/**
 * A place in a file, as the manifest stores it: the file is an index
 * into the record's own file followed by its deps, since every file a
 * finding points at is one of those.
 */
type StoredPlace = [file: number, start: number, end: number];

/** One scan's findings as the manifest stores them. */
export interface ScanRecord {
  /**
   * The file the walk came in from, set only when the scan asked which
   * class a declared shape was given, since the answer depends on it.
   * Null when the walk started at this body.
   */
  from?: string | null;
  /** Each function the body reaches, with the name it was reached by. */
  calls: Array<[...StoredPlace, string]>;
  stops?: UnfollowedCall[];
  targets?: Array<[string, ...StoredPlace]>;
  argTargets?: Array<[string, Array<[number, ...StoredPlace]>]>;
  parameterCalls?: Array<{ callee: string; parameterIndex: number }>;
  passed?: string[];
}

/**
 * A scan this run has findings for. A fresh scan lists the files it read;
 * a reused one keeps the record it came from, which the next write
 * stores again.
 */
export type RecordedScan =
  | {
      kind: "fresh";
      findings: ScanFindings;
      /** Where the walk came in from, when the findings depend on it. */
      from: string | null | undefined;
      read: ReadonlySet<string>;
    }
  | { kind: "reused"; unit: UnitRecord<ScanRecord> };

/**
 * The findings a stored record describes, or null when it points at a
 * file it does not list, which no write produces.
 */
export function fromScanRecord(
  unit: UnitRecord<ScanRecord>,
): ScanFindings | null {
  const files = [unit.file, ...unit.deps];
  const placeOf = ([file, start, end]: StoredPlace): DeclaredAt | null => {
    const path = files[file];
    return path === undefined ? null : { file: path, span: { start, end } };
  };
  const record = unit.data;
  const calls: Array<{ key: string; name: string }> = [];
  for (const [file, start, end, name] of record.calls) {
    const place = placeOf([file, start, end]);
    if (place === null) {
      return null;
    }
    calls.push({ key: offsetKeyFor(place.file, place.span), name });
  }

  const targets = new Map<string, DeclaredAt>();
  for (const [callee, ...stored] of record.targets ?? []) {
    const place = placeOf(stored);
    if (place === null) {
      return null;
    }
    targets.set(callee, place);
  }

  const argTargets = new Map<string, Map<number, DeclaredAt>>();
  for (const [callee, positions] of record.argTargets ?? []) {
    const byPosition = new Map<number, DeclaredAt>();
    for (const [position, ...stored] of positions) {
      const place = placeOf(stored);
      if (place === null) {
        return null;
      }
      byPosition.set(position, place);
    }
    argTargets.set(callee, byPosition);
  }

  return {
    calls,
    stops: record.stops ?? [],
    targets,
    argTargets,
    parameterCalls: record.parameterCalls ?? [],
    passedPositions: new Set(record.passed ?? []),
  };
}

/**
 * Whether a record is still right for a body reached from `cameFrom` this
 * time. Only a scan that asked which class a declared shape was given
 * depends on where the walk came in.
 */
export function recordValidFrom(
  record: ScanRecord,
  cameFrom: string | undefined,
): boolean {
  return record.from === undefined || record.from === (cameFrom ?? null);
}

/**
 * The unit records a write stores for the closure: one per body this run
 * has findings for, then every record still valid that this run did not
 * reach, so a later edit elsewhere can still use it.
 */
export function closureUnitRecords(
  scans: ReadonlyMap<string, RecordedScan>,
  stillValid: ReadonlyMap<string, UnitRecord<ScanRecord>>,
  references: ReferenceIndex,
): UnitRecord<ScanRecord>[] {
  const units: UnitRecord<ScanRecord>[] = [];
  for (const [key, scan] of scans) {
    if (scan.kind === "reused") {
      units.push(scan.unit);
      continue;
    }

    const file = fileOfOffsetKey(key);
    if (file === null) {
      continue;
    }

    const deps = depsOf(file, scan.findings, scan.read, references);
    const data = toScanRecord(scan.findings, scan.from, [file, ...deps]);
    if (data !== null) {
      units.push({ key, file, deps, data });
    }
  }

  for (const [key, unit] of stillValid) {
    if (!scans.has(key)) {
      units.push(unit);
    }
  }
  return units;
}

/** Every file a scan's findings point at. */
function filesNamedBy(findings: ScanFindings): string[] {
  const files: string[] = [];
  for (const call of findings.calls) {
    const file = fileOfOffsetKey(call.key);
    if (file !== null) {
      files.push(file);
    }
  }
  for (const target of findings.targets.values()) {
    files.push(target.file);
  }
  for (const byPosition of findings.argTargets.values()) {
    for (const target of byPosition.values()) {
      files.push(target.file);
    }
  }
  return files;
}

function depsOf(
  file: string,
  findings: ScanFindings,
  read: ReadonlySet<string>,
  references: ReferenceIndex,
): string[] {
  const deps = new Set<string>([
    ...read,
    ...references.directOf(file),
    ...filesNamedBy(findings),
  ]);
  deps.delete(file);
  return [...deps].sort();
}

/**
 * The findings as the manifest stores them, against `files`, which has
 * every file they point at. Null when one is missing, and then the body
 * is scanned again next time.
 */
export function toScanRecord(
  findings: ScanFindings,
  from: string | null | undefined,
  files: readonly string[],
): ScanRecord | null {
  const indexOf = new Map(files.map((file, i) => [file, i]));
  let complete = true;
  const placeOf = (place: DeclaredAt | null): StoredPlace => {
    const file = place === null ? undefined : indexOf.get(place.file);
    if (place === null || file === undefined) {
      complete = false;
      return [-1, -1, -1];
    }
    return [file, place.span.start, place.span.end];
  };

  const calls = findings.calls.map(
    ({ key, name }): [...StoredPlace, string] => [
      ...placeOf(placeOfKey(key)),
      name,
    ],
  );
  const targets = [...findings.targets].map(
    ([callee, place]): [string, ...StoredPlace] => [callee, ...placeOf(place)],
  );
  const argTargets = [...findings.argTargets].map(
    ([callee, byPosition]): [string, Array<[number, ...StoredPlace]>] => [
      callee,
      [...byPosition].map(([position, place]): [number, ...StoredPlace] => [
        position,
        ...placeOf(place),
      ]),
    ],
  );
  if (!complete) {
    return null;
  }

  return {
    ...(from === undefined ? {} : { from }),
    calls,
    ...(findings.stops.length === 0 ? {} : { stops: findings.stops }),
    ...(targets.length === 0 ? {} : { targets }),
    ...(argTargets.length === 0 ? {} : { argTargets }),
    ...(findings.parameterCalls.length === 0
      ? {}
      : { parameterCalls: [...findings.parameterCalls] }),
    ...(findings.passedPositions.size === 0
      ? {}
      : { passed: [...findings.passedPositions] }),
  };
}

function placeOfKey(key: string): DeclaredAt | null {
  const file = fileOfOffsetKey(key);
  const span = spanOfOffsetKey(key);
  return file === null || span === null ? null : { file, span };
}
