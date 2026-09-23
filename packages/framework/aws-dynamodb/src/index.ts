/**
 * Recognizes DynamoDB calls and records each one as a storage access on
 * the table, with the index, the key attributes, and the attributes the
 * call reads or writes.
 *
 * The pack matches on the command object a call is given. A project that
 * signs and posts its own requests has no command class, so the pack also
 * finds the project's request helpers by the `DynamoDB_20120810.` prefix
 * and reads each call to one the same way.
 *
 * The README explains what each input becomes, why the expression readers
 * are code, and why a table name often comes out as `{stage}-orders-v1`.
 */

import { z } from "zod";

import { compile, constructedFrom, pack, storageCalls } from "@suss/recognize";

import type { PackDeclaration } from "@suss/ir-core";
import type {
  ArgumentPick,
  CallStep,
  HelperValue,
  InputRule,
  OneArgument,
  PatternPack,
  ProjectHelper,
  ProjectHelpers,
  StatedInputs,
  StorageCalls,
  StorageMethod,
  ValueOps,
} from "@suss/recognize";

const COMMAND_MODULES = [
  "@aws-sdk/lib-dynamodb",
  "@aws-sdk/client-dynamodb",
] as const;

const RECOGNITION = "@suss/framework-aws-dynamodb";

/**
 * Callers take the command at different positions, so the step picks
 * whichever argument was built from a DynamoDB command class.
 */
const COMMAND: CallStep = {
  to: "argument",
  at: { from: 0 },
  origin: constructedFrom(...COMMAND_MODULES),
};

const COMMAND_INPUT: OneArgument = { at: 0 };

const TABLE: ArgumentPick = { at: 0, property: ["TableName"] };
const INDEX: ArgumentPick = { at: 0, property: ["IndexName"] };
const TABLES: OneArgument = { at: 0, property: ["RequestItems"] };

/**
 * A read lists its attributes in `ProjectionExpression` and a write in the
 * item it puts, so a read with no projection reads everything. A batch
 * lists them per table, inside that table's entry.
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
  if (kind !== "write") {
    return everything(kind);
  }
  const written = namesIn(input.property("Item"));
  if (written.length > 0) {
    return written;
  }
  const updated = updatedAttributes(input);
  return updated.length > 0 ? updated : everything(kind);
};

/**
 * The key an item command gives, or the attributes a query's key
 * condition uses. A batch returns none here, because `ATTRIBUTES`
 * already reads the keys inside each table's entry.
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

/** A read that lists no attributes reads all of them. */
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
 * Each command appears under its document-client and raw-client name,
 * since both put the table and attribute names at the same paths.
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

function namesIn(value: ValueOps | null): string[] {
  const found: string[] = [];
  for (const entry of value?.entries("nothing") ?? []) {
    if (entry.key !== null) {
      found.push(entry.key);
    }
  }
  return found;
}

/** Null when the read has no `ProjectionExpression`. */
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
 * Maps each `#alias` in `ExpressionAttributeNames` to the attribute it
 * replaces. Code uses an alias to avoid DynamoDB's reserved words.
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

/** Empty when `UpdateExpression` is missing or is not a string literal. */
function updatedAttributes(input: ValueOps): string[] {
  const expression = input.property("UpdateExpression")?.text() ?? null;
  return expression === null
    ? []
    : updateExpressionAttributes(expression, aliasesIn(input));
}

/** The keys in a batch entry whose values list attributes. */
const REQUESTED = ["Item", "Key", "Keys"];

/**
 * Collects what a batch put writes and the keys a batch get or delete
 * gives. Each batch command nests these at a different depth in its
 * entry, so the walk searches the whole entry.
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

/** A request gives one item or a list of them. */
function attributeNames(value: ValueOps): string[] {
  const items = value.items();
  return items.length > 0 ? items.flatMap(namesIn) : namesIn(value);
}

/**
 * In a key condition an attribute comes before a comparison, as the first
 * argument of a function, or before a range keyword and its value.
 * Matching on position keeps DynamoDB's keywords out of this source.
 */
const ATTRIBUTE_POSITIONS = [
  /([#\w.]+)\s*(?:<>|<=|>=|=|<|>)/g,
  /\(\s*([#\w.]+)\s*,/g,
  /([#\w.]+)\s+[A-Za-z_]+\s+:/g,
];

/**
 * Resolves each `#alias` token through the call's aliases and keeps each
 * attribute once. An alias missing from the map is dropped.
 */
function attributeCollector(names: Map<string, string>): {
  found: string[];
  add: (token: string | undefined) => void;
} {
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
  return { found, add };
}

function keyConditionAttributes(
  expression: string,
  names: Map<string, string>,
): string[] {
  const { found, add } = attributeCollector(names);
  for (const pattern of ATTRIBUTE_POSITIONS) {
    for (const match of expression.matchAll(pattern)) {
      add(match[1]);
    }
  }
  return found;
}

type UpdateClauseKeyword = "set" | "remove" | "add" | "delete";

/**
 * Splits an update expression at each clause keyword. The loop uses
 * `exec` because `matchAll` types a match's `index` as optional.
 */
function updateClauses(
  expression: string,
): Array<{ keyword: UpdateClauseKeyword; body: string }> {
  const pattern = /\b(set|remove|add|delete)\b/gi;
  const starts: Array<{
    keyword: UpdateClauseKeyword;
    index: number;
    bodyStart: number;
  }> = [];
  for (
    let match = pattern.exec(expression);
    match !== null;
    match = pattern.exec(expression)
  ) {
    starts.push({
      keyword: match[0].toLowerCase() as UpdateClauseKeyword,
      index: match.index,
      bodyStart: match.index + match[0].length,
    });
  }
  return starts.map(({ keyword, bodyStart }, position) => ({
    keyword,
    body: expression.slice(
      bodyStart,
      starts[position + 1]?.index ?? expression.length,
    ),
  }));
}

/** The caller trims the item first, so the token is never empty. */
function firstToken(item: string): string {
  return item.split(/\s+/)[0];
}

/**
 * The attribute path is before the `=` in a SET item, the whole item in a
 * REMOVE, and the first token in an ADD or a DELETE.
 */
const CLAUSE_PATH: Record<
  UpdateClauseKeyword,
  (item: string) => string | null
> = {
  set: (item) => {
    const at = item.indexOf("=");
    return at === -1 ? null : item.slice(0, at);
  },
  remove: (item) => item,
  add: firstToken,
  delete: firstToken,
};

/** `b.c` and `items[0]` both touch the attribute they start with. */
function firstPathElement(path: string): string | undefined {
  return /^[#\w]+/.exec(path.trim())?.[0];
}

/**
 * Splitting on commas also breaks up a call like `if_not_exists(a, :x)`
 * in a SET item. The piece after that comma has no `=`, so it is skipped
 * and the item still gives one attribute.
 */
function updateExpressionAttributes(
  expression: string,
  names: Map<string, string>,
): string[] {
  const { found, add } = attributeCollector(names);
  for (const clause of updateClauses(expression)) {
    for (const raw of clause.body.split(",")) {
      const item = raw.trim();
      if (item === "") {
        continue;
      }
      const path = CLAUSE_PATH[clause.keyword](item);
      if (path === null) {
        continue;
      }
      add(firstPathElement(path));
    }
  }
  return found;
}

/**
 * A project's own function that signs and posts a DynamoDB request. The
 * pack finds these by reading the project's helpers before extraction.
 */
interface DynamoRequestFunction {
  name: string;
  operationArg: number;
  requestArg: number;
  operations: Record<string, "read" | "write">;
}

export const optionsSchema = z
  .object({
    /**
     * More modules that get a file read when it imports them. A relative
     * import of a helper matches no module, so the usual entry is the
     * signing library the helper imports.
     */
    requiresImport: z.array(z.string()).optional(),
  })
  .strict();

export type DynamoPackOptions = z.infer<typeof optionsSchema>;

/**
 * The operation argument picks read or write, and the request argument
 * has the same layout as a command's input.
 */
function requestFunctionCalls(spec: DynamoRequestFunction): StorageCalls {
  const operation: ArgumentPick = { at: spec.operationArg };
  const request = (property: string): OneArgument => ({
    at: spec.requestArg,
    property: [property],
  });

  // There is no origin check, because a call site imports the helper by
  // a relative path that is written differently at every depth.
  return storageCalls({ system: "aws.dynamodb" })
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

/** An example call to the helper, with its operation and request in place. */
function exampleCall(spec: DynamoRequestFunction): string {
  const [operation] = Object.keys(spec.operations);
  const written: string[] = [];
  for (let at = 0; at <= Math.max(spec.operationArg, spec.requestArg); at++) {
    written.push(argumentText(spec, at, operation ?? ""));
  }
  return `${spec.name}(${written.join(", ")})`;
}

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
  // The declaration never reads the helper's other arguments.
  return "undefined";
}

/**
 * DynamoDB defines whether each operation reads or writes, so a project
 * that posts its own requests never has to list them.
 */
const WIRE_OPERATIONS: Record<string, "read" | "write"> = {
  GetItem: "read",
  BatchGetItem: "read",
  Query: "read",
  Scan: "read",
  TransactGetItems: "read",
  PutItem: "write",
  UpdateItem: "write",
  DeleteItem: "write",
  BatchWriteItem: "write",
  TransactWriteItems: "write",
};

/** Every DynamoDB request gives its operation in this header. */
const TARGET_HEADER = "X-Amz-Target";

const TARGET_SERVICE = "DynamoDB_20120810";
const TARGET_PREFIX = `${TARGET_SERVICE}.`;

/** The `fetch` options where a helper puts the request and its headers. */
const BODY_PROPERTY = "body";
const HEADERS_PROPERTY = "headers";

/**
 * Finds the project's helpers over DynamoDB's HTTP API by the target
 * prefix, and recognizes each call to one the way a command is.
 */
const REQUEST_HELPERS: ProjectHelpers = {
  find: { by: "text", contains: [TARGET_PREFIX] },
  declare: (helpers) => ({
    invocationRecognizers: helpers
      .flatMap((helper) => requestFunctionOf(helper) ?? [])
      .map((spec) => compile(requestFunctionCalls(spec).declared, RECOGNITION)),
  }),
};

/**
 * Null unless the helper posts a DynamoDB request whose operation and
 * body both come from its parameters.
 */
function requestFunctionOf(
  helper: ProjectHelper,
): DynamoRequestFunction | null {
  for (const sink of helper.sinks) {
    for (const argument of sink.arguments) {
      if (argument.as !== "object") {
        continue;
      }
      const operationArg = operationParameter(argument.properties);
      const requestArg = requestParameter(argument.properties[BODY_PROPERTY]);
      if (operationArg !== null && requestArg !== null) {
        return {
          name: helper.name,
          operationArg,
          requestArg,
          operations: WIRE_OPERATIONS,
        };
      }
    }
  }
  return null;
}

/** The parameter that fills the target header after the service prefix. */
function operationParameter(
  properties: Record<string, HelperValue>,
): number | null {
  const headers = properties[HEADERS_PROPERTY];
  if (headers?.as !== "object") {
    return null;
  }
  const target = headers.properties[TARGET_HEADER];
  if (target?.as !== "text" || !target.text.startsWith(TARGET_PREFIX)) {
    return null;
  }
  return slotIn(target.text.slice(TARGET_PREFIX.length));
}

/** The parameter the body is, passed directly or through `JSON.stringify`. */
function requestParameter(value: HelperValue | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (value.as === "parameter" && value.property === undefined) {
    return value.position;
  }
  return value.as === "call" && value.callee === "JSON.stringify"
    ? requestParameter(value.arguments[0])
    : null;
}

/** The parameter position when the text is only a slot, as in `"{2}"`. */
function slotIn(text: string): number | null {
  const slot = /^\{(\d+)\}$/.exec(text);
  return slot === null ? null : Number(slot[1]);
}

/**
 * The pack reads a file that imports a DynamoDB client module or one of
 * the modules in `requiresImport`.
 */
export function dynamoFramework(options: DynamoPackOptions = {}): PatternPack {
  return pack("aws-dynamodb", [COMMAND_CALLS], {
    languages: ["typescript", "javascript"],
    recognizedAs: RECOGNITION,
    protocol: "dynamodb",
    projectHelpers: REQUEST_HELPERS,
    ...(options.requiresImport === undefined
      ? {}
      : { requiresImport: options.requiresImport }),
  });
}

export const declares: PackDeclaration = {
  kind: "effects",
  package: "@suss/framework-aws-dynamodb",
  dependencies: [
    { ecosystem: "npm", name: "@aws-sdk/lib-dynamodb" },
    { ecosystem: "npm", name: "@aws-sdk/client-dynamodb" },
  ],
  reads:
    "AWS SDK v3 DynamoDB calls. Each one becomes a storage-access interaction.",
};

export default dynamoFramework;
