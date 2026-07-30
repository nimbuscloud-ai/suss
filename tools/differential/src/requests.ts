// requests.ts — deterministic request batteries for a generated program.
//
// For each field a program observes, the battery tries: the field absent,
// the empty string (falsy but present), a generic truthy value, and every
// literal the program compares that field against. Small programs get the
// full cross product; larger ones get a seeded-PRNG sample plus the
// all-absent and all-present corners. Deterministic by construction —
// shrinking happens over programs, never over requests.

import {
  collectComparedValues,
  collectFields,
  type HandlerProgram,
  type ReqField,
} from "./program.js";

export interface GeneratedRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Sentinel meaning "leave this field off the request entirely". */
const ABSENT = Symbol("absent");
type Candidate = string | typeof ABSENT;

const MAX_EXHAUSTIVE = 96;
const SAMPLE_SIZE = 64;

function candidatesFor(program: HandlerProgram, field: ReqField): Candidate[] {
  const literals = collectComparedValues(program, field);
  const base: Candidate[] = [ABSENT, "", "a"];
  const all = [...base, ...literals];
  return [...new Set(all)];
}

function buildRequest(
  fields: ReqField[],
  assignment: Candidate[],
): GeneratedRequest {
  const request: GeneratedRequest = {
    params: {},
    query: {},
    headers: {},
    body: {},
  };
  for (let i = 0; i < fields.length; i++) {
    const value = assignment[i];
    if (value === ABSENT) {
      continue;
    }
    const field = fields[i];
    request[field.source][field.key] = value;
  }
  return request;
}

/** mulberry32 — tiny deterministic PRNG; seeded from the program text. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashText(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function exhaustiveAssignments(pools: Candidate[][]): Candidate[][] {
  let assignments: Candidate[][] = [[]];
  for (const pool of pools) {
    assignments = assignments.flatMap((prefix) =>
      pool.map((candidate): Candidate[] => [...prefix, candidate]),
    );
  }
  return assignments;
}

function sampledAssignments(pools: Candidate[][], seed: number): Candidate[][] {
  const random = mulberry32(seed);
  const assignments: Candidate[][] = [
    pools.map(() => ABSENT),
    pools.map((pool) => pool.find((c) => c !== ABSENT) ?? ABSENT),
  ];
  for (let i = 0; i < SAMPLE_SIZE; i++) {
    assignments.push(
      pools.map((pool) => pool[Math.floor(random() * pool.length)]),
    );
  }
  return assignments;
}

/**
 * The deterministic request battery for a program. Exhaustive over the
 * per-field candidate pools when small enough; seeded sample otherwise.
 */
export function requestBattery(program: HandlerProgram): GeneratedRequest[] {
  const fields = collectFields(program);
  if (fields.length === 0) {
    return [{ params: {}, query: {}, headers: {}, body: {} }];
  }

  const pools = fields.map((field) => candidatesFor(program, field));
  const productSize = pools.reduce((acc, pool) => acc * pool.length, 1);

  const assignments =
    productSize <= MAX_EXHAUSTIVE
      ? exhaustiveAssignments(pools)
      : sampledAssignments(pools, hashText(JSON.stringify(program)));

  return assignments.map((assignment) => buildRequest(fields, assignment));
}
