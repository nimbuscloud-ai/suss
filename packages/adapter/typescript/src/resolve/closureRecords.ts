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

import { fileOfOffsetKey } from "../walk/nodeKeys.js";

import type { DeclaredAt, UnfollowedCall } from "@suss/behavioral-ir";
import type { UnitRecord } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ReferenceIndex } from "../referencedFiles.js";

/** One scan's findings, as plain data the manifest can store. */
export interface ScanRecord {
  /**
   * The file the walk came in from, set only when the scan asked which
   * class a declared shape was given, since the answer depends on it.
   * Null when the walk started at this body.
   */
  from?: string | null;
  /** Each function the body reaches, by key, with the name it was reached by. */
  calls: Array<[string, string]>;
  stops?: UnfollowedCall[];
  targets?: Array<[string, DeclaredAt]>;
  argTargets?: Array<[string, Array<[number, DeclaredAt]>]>;
  parameterCalls?: Array<{ callee: string; parameterIndex: number }>;
  passed?: string[];
}

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
 * A scan this run has findings for. A fresh scan lists the files it read;
 * a reused one keeps the deps it was stored with, which the next write
 * stores again.
 */
export type RecordedScan =
  | { kind: "fresh"; record: ScanRecord; read: ReadonlySet<string> }
  | { kind: "reused"; unit: UnitRecord<ScanRecord> };

export function toScanRecord(
  findings: ScanFindings,
  from: string | null | undefined,
): ScanRecord {
  const argTargets = [...findings.argTargets].map(
    ([callee, byPosition]): [string, Array<[number, DeclaredAt]>] => [
      callee,
      [...byPosition],
    ],
  );
  return {
    ...(from === undefined ? {} : { from }),
    calls: findings.calls.map((call) => [call.key, call.name]),
    ...(findings.stops.length === 0 ? {} : { stops: findings.stops }),
    ...(findings.targets.size === 0 ? {} : { targets: [...findings.targets] }),
    ...(argTargets.length === 0 ? {} : { argTargets }),
    ...(findings.parameterCalls.length === 0
      ? {}
      : { parameterCalls: [...findings.parameterCalls] }),
    ...(findings.passedPositions.size === 0
      ? {}
      : { passed: [...findings.passedPositions] }),
  };
}

export function fromScanRecord(record: ScanRecord): ScanFindings {
  return {
    calls: record.calls.map(([key, name]) => ({ key, name })),
    stops: record.stops ?? [],
    targets: new Map(record.targets ?? []),
    argTargets: new Map(
      (record.argTargets ?? []).map(([callee, byPosition]) => [
        callee,
        new Map(byPosition),
      ]),
    ),
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

    units.push({
      key,
      file,
      deps: depsOf(file, scan.record, scan.read, references),
      data: scan.record,
    });
  }

  for (const [key, unit] of stillValid) {
    if (!scans.has(key)) {
      units.push(unit);
    }
  }
  return units;
}

function depsOf(
  file: string,
  record: ScanRecord,
  read: ReadonlySet<string>,
  references: ReferenceIndex,
): string[] {
  const deps = new Set<string>(read);
  for (const imported of references.directOf(file)) {
    deps.add(imported);
  }
  for (const [calleeKey] of record.calls) {
    const calleeFile = fileOfOffsetKey(calleeKey);
    if (calleeFile !== null) {
      deps.add(calleeFile);
    }
  }
  for (const [, target] of record.targets ?? []) {
    deps.add(target.file);
  }
  for (const [, byPosition] of record.argTargets ?? []) {
    for (const [, target] of byPosition) {
      deps.add(target.file);
    }
  }
  deps.delete(file);
  return [...deps].sort();
}
