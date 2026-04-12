// @suss/extractor — FrameworkPack interface
//
// Framework packs are declarative data that tell the language adapter WHAT to look for.
// The adapter knows HOW to look for it in the language's AST.

// =============================================================================
// Discovery
// =============================================================================

export type DiscoveryMatch =
  | {
      type: "namedExport";
      names: string[]; // e.g. ["loader", "action"] for React Router
    }
  | {
      type: "registrationCall";
      importModule: string; // e.g. "@ts-rest/express"
      importName: string; // e.g. "initServer"
      registrationChain: string[]; // e.g. [".router"]
    }
  | {
      type: "decorator";
      decoratorModule: string;
      decoratorName: string;
    }
  | {
      type: "fileConvention";
      filePattern: string; // glob
      exportNames: string[];
    };

export type BindingExtraction = {
  method:
    | { type: "fromRegistration"; position: "methodName" | number }
    | { type: "fromExportName" } // Next.js: the export name IS the method
    | { type: "fromContract" } // ts-rest: method comes from the contract definition
    | { type: "literal"; value: string };
  path:
    | { type: "fromRegistration"; position: number }
    | { type: "fromFilename" } // file-based routing
    | { type: "fromContract" }; // ts-rest: path comes from the contract definition
};

export interface DiscoveryPattern {
  /** The kind of code unit this discovers: "handler", "loader", "action", "component", etc. */
  kind: string;
  match: DiscoveryMatch;
  bindingExtraction?: BindingExtraction;
}

// =============================================================================
// Terminals
// =============================================================================

export type TerminalMatch =
  | {
      type: "returnShape";
      requiredProperties?: string[]; // e.g. ["status", "body"] for ts-rest
    }
  | {
      type: "parameterMethodCall";
      parameterPosition: number; // which param is the response object (1 for Express res)
      methodChain: string[]; // e.g. ["status", "json"]
    }
  | {
      type: "throwExpression";
      constructorPattern?: string; // e.g. "httpErrorJson", "HttpError"
    }
  | {
      type: "functionCall";
      functionName: string; // e.g. "json", "redirect" — matches calls to a named function
    };

export interface TerminalExtraction {
  statusCode?:
    | { from: "property"; name: string } // { status: 200 } → name: "status"
    | { from: "argument"; position: number; minArgs?: number } // res.status(200) → position: 0
    | { from: "constructor" }; // new HttpError.NotFound → infer 404
  body?:
    | { from: "property"; name: string } // { body: data } → name: "body"
    | { from: "argument"; position: number; minArgs?: number }; // res.json(data) → position: 0
}

export interface TerminalPattern {
  /** What kind of output this terminal produces: "response", "throw", "return", "render" */
  kind: "response" | "throw" | "return" | "render";
  match: TerminalMatch;
  extraction: TerminalExtraction;
}

// =============================================================================
// Contract reading
// =============================================================================

export interface ContractPattern {
  /** How to find the contract object. Contracts are data structures, not code units,
   *  so this is a simpler shape than DiscoveryPattern. */
  discovery: {
    importModule: string; // e.g. "@ts-rest/core"
    importName: string; // e.g. "initContract"
    registrationChain: string[]; // e.g. [".router"]
  };
  responseExtraction: {
    /** Property on the contract object that holds the responses map */
    property: string;
  };
  paramsExtraction?: {
    property: string;
  };
}

// =============================================================================
// Input mapping
// =============================================================================

export type InputMappingPattern =
  | {
      /** Single object parameter, e.g. React Router LoaderFunctionArgs */
      type: "singleObjectParam";
      paramPosition: number;
      /** Property name → role, e.g. { params: "pathParams", request: "request" } */
      knownProperties: Record<string, string>;
    }
  | {
      /** Positional parameters, e.g. Express (req, res, next) */
      type: "positionalParams";
      params: Array<{ position: number; role: string }>;
    }
  | {
      /** Destructured from framework call, e.g. ts-rest { params, body, query } */
      type: "destructuredObject";
      /** Property name → role, e.g. { params: "pathParams", body: "requestBody" } */
      knownProperties: Record<string, string>;
    };

// =============================================================================
// FrameworkPack
// =============================================================================

export interface FrameworkPack {
  name: string;
  languages: string[];
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  contractReading?: ContractPattern;
  inputMapping: InputMappingPattern;
}
