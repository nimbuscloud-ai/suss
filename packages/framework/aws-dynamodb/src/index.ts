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

import { compile, constructedFrom, pack, storageCalls } from "@suss/recognize";

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
 * A function of the project's own that signs and posts a DynamoDB
 * request itself, so there is no command class to match on. The index
 * reads it out of the project before extraction; the README says how.
 */
interface DynamoRequestFunction {
  /** What the function is called where it is called. */
  name: string;
  /** Which argument says which operation the request performs. */
  operationArg: number;
  /** Which argument is the request itself. */
  requestArg: number;
  /** What each operation the function accepts does to the table. */
  operations: Record<string, "read" | "write">;
}

/**
 * What `-f aws-dynamodb=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
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
 * A call to a request function the index found. The operation argument
 * decides whether the call reads or writes, and the request argument is
 * the same object a command class takes.
 */
function requestFunctionCalls(spec: DynamoRequestFunction): StorageCalls {
  const operation: ArgumentPick = { at: spec.operationArg };
  const request = (property: string): OneArgument => ({
    at: spec.requestArg,
    property: [property],
  });

  // No origin: a project reaches its own helper by a relative path,
  // which is spelled differently at every depth.
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

/**
 * What each operation the wire accepts does to the table, so a project
 * that posts its own request needs to say nothing about them.
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

/** The header every DynamoDB request states its operation in. */
const TARGET_HEADER = "X-Amz-Target";

/** The service part of that header, before the operation itself. */
const TARGET_SERVICE = "DynamoDB_20120810";
const TARGET_PREFIX = `${TARGET_SERVICE}.`;

/** Where a request body goes on its way to `fetch`. */
const BODY_PROPERTY = "body";
const HEADERS_PROPERTY = "headers";

/**
 * The helpers this project wrote in front of DynamoDB's HTTP API, and
 * the calls to each of them, recognized the way a command class is.
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
 * A helper read as a request function, or null when its body posts no
 * DynamoDB request whose operation and body both come from a parameter.
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

/** Which parameter reaches the target header, after the wire's prefix. */
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

/** A whole value that is one parameter, `JSON.stringify` or not. */
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

/** The parameter a piece of text is nothing but, as in `"{2}"`. */
function slotIn(text: string): number | null {
  const slot = /^\{(\d+)\}$/.exec(text);
  return slot === null ? null : Number(slot[1]);
}

/**
 * Pack export. One declaration per anchor, gated on a file importing a
 * DynamoDB client module, which is where a command class comes from, or
 * any further module the project configured.
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

export default dynamoFramework;
