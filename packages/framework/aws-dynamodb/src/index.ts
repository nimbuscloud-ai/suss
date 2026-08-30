/**
 * Recognize DynamoDB calls and emit `storage-access` effects.
 *
 * The anchor is the command, wherever a call takes one, and the command
 * says which table, which index, whether the call reads or writes, and
 * which attributes it touches. A project that signs and posts the
 * request itself writes no command class, so a second declaration reads
 * a function the project lists in pack config, and the request object
 * is read the same way from there on.
 *
 * The README says what each input contributes, why two links here are
 * code rather than data, and why a table name often comes out as a
 * pattern like `{stage}-orders-v1`.
 */

import { z } from "zod";

import { constructedFrom, pack, storageCalls } from "@suss/recognize";

import type {
  ArgumentPick,
  CallStep,
  InputRule,
  OneArgument,
  PatternPack,
  StatedInputs,
  StorageCalls,
  StorageMethod,
  ValueOps,
} from "@suss/recognize";

/** The modules a command class can come from. */
const COMMAND_MODULES = [
  "@aws-sdk/lib-dynamodb",
  "@aws-sdk/client-dynamodb",
] as const;

const RECOGNITION = "@suss/framework-aws-dynamodb";

/**
 * The command a call was handed, wherever the call takes it. Saying
 * which module built it settles the match on the argument itself, so
 * the chain reads nothing out of the arguments beside it.
 */
const COMMAND: CallStep = {
  to: "argument",
  at: { from: 0 },
  origin: constructedFrom(...COMMAND_MODULES),
};

/** Where a command states everything about the access. */
const COMMAND_INPUT: OneArgument = { at: 0 };

/**
 * Where a command says which table and which index, and where it says
 * which tables when it reaches several at once.
 */
const TABLE: ArgumentPick = { at: 0, property: ["TableName"] };
const INDEX: ArgumentPick = { at: 0, property: ["IndexName"] };
const TABLES: OneArgument = { at: 0, property: ["RequestItems"] };

/**
 * The attributes a call touches. A read states them in its projection,
 * and a write states them as the item it puts, so an absent projection
 * is a read of everything the item has. A batch states them once per
 * table, inside that table's own entry.
 */
const ATTRIBUTES: InputRule = ({ input, entry, kind }: StatedInputs) => {
  if (entry !== null) {
    const requested = requestedAttributes(entry);
    return requested.length > 0 ? requested : everything(kind);
  }
  const projected = projectedAttributes(input);
  if (projected !== null) {
    return projected;
  }
  const written = namesIn(input.property("Item"));
  return kind === "write" && written.length > 0 ? written : everything(kind);
};

/**
 * What a call gives DynamoDB to pick items by: the key an item-level
 * command states, or the attributes a query's key condition uses. A
 * batch picks its items inside each table's entry, which is where the
 * attributes it touches are read from already.
 */
const KEY_ATTRIBUTES: InputRule = ({ input, entry }: StatedInputs) => {
  if (entry !== null) {
    return [];
  }
  const key = namesIn(input.property("Key"));
  if (key.length > 0) {
    return key;
  }
  const condition = input.property("KeyConditionExpression")?.text() ?? null;
  return condition === null
    ? []
    : keyConditionAttributes(condition, aliasesIn(input));
};

/** What a call that states no attributes touched: all of them, or none. */
function everything(kind: "read" | "write"): string[] {
  return kind === "read" ? ["*"] : [];
}

const READ: StorageMethod = {
  kind: "read",
  fields: ATTRIBUTES,
  selector: KEY_ATTRIBUTES,
};
const WRITE: StorageMethod = {
  kind: "write",
  fields: ATTRIBUTES,
  selector: KEY_ATTRIBUTES,
};

/**
 * Every command this reads, and whether it reads or writes. The
 * document-client name and the raw-client name both appear, since a
 * project picks one and the input shape is the same either way.
 */
const COMMANDS: Record<string, StorageMethod> = {
  GetCommand: READ,
  GetItemCommand: READ,
  QueryCommand: READ,
  ScanCommand: READ,
  BatchGetCommand: READ,
  BatchGetItemCommand: READ,
  PutCommand: WRITE,
  PutItemCommand: WRITE,
  UpdateCommand: WRITE,
  UpdateItemCommand: WRITE,
  DeleteCommand: WRITE,
  DeleteItemCommand: WRITE,
  BatchWriteCommand: WRITE,
  BatchWriteItemCommand: WRITE,
};

const COMMAND_CALLS = storageCalls({
  system: "aws.dynamodb",
  transport: "aws-sdk",
})
  .about(COMMAND)
  .methods(COMMANDS)
  .input(COMMAND_INPUT)
  .container(TABLE)
  .accessPath(INDEX)
  .containersIn(TABLES)
  .example(
    'client.send(new GetCommand({ TableName: "orders-v1", Key: { orderId: "a" } }))',
  );

/** What the properties of one object are called. */
function namesIn(value: ValueOps | null): string[] {
  const found: string[] = [];
  for (const entry of value?.entries("nothing") ?? []) {
    if (entry.key !== null) {
      found.push(entry.key);
    }
  }
  return found;
}

/** The attributes a read asks for, or null when it asks for none by name. */
function projectedAttributes(input: ValueOps): string[] | null {
  const projection = input.property("ProjectionExpression")?.text() ?? null;
  if (projection === null) {
    return null;
  }
  const aliases = aliasesIn(input);
  return projection
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field !== "")
    .map((field) => aliases.get(field) ?? field);
}

/**
 * What DynamoDB calls a name in an expression, when the code hides it
 * behind an alias to keep clear of the reserved words.
 */
function aliasesIn(input: ValueOps): Map<string, string> {
  const names = new Map<string, string>();
  const declared = input.property("ExpressionAttributeNames");
  for (const entry of declared?.entries("nothing") ?? []) {
    const written = entry.value.text();
    if (entry.key !== null && written !== null) {
      names.set(entry.key, written);
    }
  }
  return names;
}

/** Where a batch's requests state the attributes they touch. */
const REQUESTED = ["Item", "Key", "Keys"];

/**
 * The attributes a batch's requests touch: what a put writes, and the
 * keys a get or a delete states. Each command nests them differently
 * inside its entry, so this looks wherever they are rather than at one
 * path.
 */
function requestedAttributes(requests: ValueOps): string[] {
  const found = new Set<string>();
  const walk = (value: ValueOps): void => {
    for (const item of value.items()) {
      walk(item);
    }
    for (const entry of value.entries("nothing")) {
      if (entry.key !== null && REQUESTED.includes(entry.key)) {
        for (const name of attributeNames(entry.value)) {
          found.add(name);
        }
      }
      walk(entry.value);
    }
  };
  walk(requests);
  return [...found];
}

/** The attributes one request states, as one item or as a list of them. */
function attributeNames(value: ValueOps): string[] {
  const items = value.items();
  return items.length > 0 ? items.flatMap(namesIn) : namesIn(value);
}

/**
 * Where an attribute appears in a key condition: before a comparison,
 * as the first argument of a function, or before a range keyword and
 * the value it compares against. Matching on position rather than on a
 * list of keywords keeps DynamoDB's own words out of this source.
 */
const ATTRIBUTE_POSITIONS = [
  /([#\w.]+)\s*(?:<>|<=|>=|=|<|>)/g,
  /\(\s*([#\w.]+)\s*,/g,
  /([#\w.]+)\s+[A-Za-z_]+\s+:/g,
];

/**
 * The attributes a key condition keys on, with an alias looked up
 * through what the call says each one is written as.
 */
function keyConditionAttributes(
  expression: string,
  names: Map<string, string>,
): string[] {
  const found: string[] = [];
  const add = (token: string | undefined): void => {
    if (token === undefined) {
      return;
    }
    const name = token.startsWith("#") ? names.get(token) : token;
    if (name !== undefined && !found.includes(name)) {
      found.push(name);
    }
  };
  for (const pattern of ATTRIBUTE_POSITIONS) {
    for (const match of expression.matchAll(pattern)) {
      add(match[1]);
    }
  }
  return found;
}

/**
 * A function of the project's own that sends a DynamoDB request. The
 * pack recognizes the SDK's command classes, and a service that signs
 * and posts the request itself writes none of them, so the project says
 * which of its own functions does that. The README gives an example.
 */
const requestFunction = z
  .object({
    /** What the function is called where it is called. */
    name: z.string(),
    /**
     * The module specifier a call site imports it from. Leave it out when
     * call sites reach it by different relative paths; then the name
     * alone picks it out among the files the import gate admits.
     */
    module: z.string().optional(),
    /** Which argument says which operation the request performs. */
    operationArg: z.number(),
    /** Which argument is the request itself. */
    requestArg: z.number(),
    /** What each operation the function accepts does to the table. */
    operations: z.record(z.string(), z.enum(["read", "write"])),
  })
  .strict();

export type DynamoRequestFunction = z.infer<typeof requestFunction>;

/**
 * What `-f aws-dynamodb=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    requestFunctions: z.array(requestFunction).optional(),
    /**
     * Further modules whose presence makes a file worth reading. A helper
     * imported by a relative path gives the gate nothing to match on; the
     * signing library that helper imports gives it something.
     */
    requiresImport: z.array(z.string()).optional(),
  })
  .strict();

export type DynamoPackOptions = z.infer<typeof optionsSchema>;

/**
 * A call to a request function the project configured. The operation
 * argument decides whether the call reads or writes, and the request
 * argument is the same object a command class takes.
 */
function requestFunctionCalls(spec: DynamoRequestFunction): StorageCalls {
  const operation: ArgumentPick = { at: spec.operationArg };
  const request = (property: string): OneArgument => ({
    at: spec.requestArg,
    property: [property],
  });

  return storageCalls({
    system: "aws.dynamodb",
    ...(spec.module === undefined
      ? {}
      : { client: constructedFrom(spec.module) }),
  })
    .methods({
      [spec.name]: {
        operation,
        kind: { asks: operation, means: spec.operations },
        fields: ATTRIBUTES,
        selector: KEY_ATTRIBUTES,
      },
    })
    .input({ at: spec.requestArg })
    .container(request("TableName"))
    .accessPath(request("IndexName"))
    .containersIn(request("RequestItems"))
    .example(exampleCall(spec));
}

/** A call to the configured function, written the way the config says. */
function exampleCall(spec: DynamoRequestFunction): string {
  const [operation] = Object.keys(spec.operations);
  const written: string[] = [];
  for (let at = 0; at <= Math.max(spec.operationArg, spec.requestArg); at++) {
    written.push(argumentText(spec, at, operation ?? ""));
  }
  return `${spec.name}(${written.join(", ")})`;
}

/** What the example passes in one position. */
function argumentText(
  spec: DynamoRequestFunction,
  at: number,
  operation: string,
): string {
  if (at === spec.operationArg) {
    return JSON.stringify(operation);
  }
  if (at === spec.requestArg) {
    return '{ TableName: "orders-v1", Key: { orderId: "a" } }';
  }
  // Whatever else the function takes is the project's own business, and
  // the declaration reads none of it.
  return "undefined";
}

const isArgumentPosition = (index: unknown): boolean =>
  Number.isInteger(index) && (index as number) >= 0;

/**
 * Rejecting a half-written entry here rather than reading nothing later
 * turns a typo into a message from the CLI that says which file to fix.
 */
function checkRequestFunction(spec: DynamoRequestFunction, at: number): void {
  const complain = (problem: string): never => {
    throw new Error(`requestFunctions[${at}] ${problem}`);
  };
  if (typeof spec.name !== "string" || spec.name === "") {
    complain("needs the name of a function to read.");
  }
  if (!isArgumentPosition(spec.operationArg)) {
    complain("needs operationArg: which argument says the operation, from 0.");
  }
  if (!isArgumentPosition(spec.requestArg)) {
    complain("needs requestArg: which argument is the request, from 0.");
  }
  const operations = Object.entries(spec.operations ?? {});
  if (operations.length === 0) {
    complain("needs operations, saying what each one does to the table.");
  }
  for (const [operation, kind] of operations) {
    if (kind !== "read" && kind !== "write") {
      complain(`gives ${operation} as ${String(kind)}, not read or write.`);
    }
  }
}

/**
 * Pack export. One declaration per anchor, gated on a file importing a
 * DynamoDB client module, which is where a command class comes from, or
 * any further module the project configured.
 */
export function dynamoFramework(options: DynamoPackOptions = {}): PatternPack {
  const requestFunctions = options.requestFunctions ?? [];
  requestFunctions.forEach(checkRequestFunction);

  return pack(
    "aws-dynamodb",
    [COMMAND_CALLS, ...requestFunctions.map(requestFunctionCalls)],
    {
      languages: ["typescript", "javascript"],
      recognizedAs: RECOGNITION,
      protocol: "dynamodb",
      ...(options.requiresImport === undefined
        ? {}
        : { requiresImport: options.requiresImport }),
    },
  );
}

export default dynamoFramework;
