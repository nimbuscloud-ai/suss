// @suss/extractor — PatternPack interface
//
// Pattern packs are declarative data that tell the language adapter WHAT to look for.
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
    }
  | {
      type: "clientCall";
      /** Module the client is imported from, or "global" for built-ins like fetch */
      importModule: string;
      /** Named export or identifier — e.g. "initClient", "fetch" */
      importName: string;
      /** If set, only match calls to these methods on the client (e.g. ["getUser"]).
       *  Unset means any method call (or bare call for globals). */
      methodFilter?: string[];
      /**
       * Method names on the import that produce a client-equivalent instance,
       * so variables initialized from those calls also act as discovery
       * subjects. axios uses `axios.create({...})` to build a baseURL-bound
       * instance; declaring `factoryMethods: ["create"]` lets the adapter
       * treat `api.get(...)` (where `api = axios.create(...)`) the same as
       * `axios.get(...)`.
       */
      factoryMethods?: string[];
    };

export type BindingExtraction = {
  method:
    | { type: "fromRegistration"; position: "methodName" | number }
    | { type: "fromExportName" }
    | { type: "fromContract" }
    | { type: "fromClientMethod" }
    | {
        type: "fromArgumentProperty";
        position: number;
        property: string;
        default?: string;
      }
    | { type: "literal"; value: string };
  path:
    | { type: "fromRegistration"; position: number }
    | { type: "fromFilename" }
    | { type: "fromContract" }
    | { type: "fromClientMethod" }
    | { type: "fromArgumentLiteral"; position: number };
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
      type: "returnStatement";
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
    }
  | {
      /**
       * Return statement whose value is a JSX element or fragment. The
       * root element/component name is recorded in RawTerminal.component.
       * Used by React (and any other JSX-based framework pack) to
       * classify component outputs as `render` terminals.
       */
      type: "jsxReturn";
    };

export interface TerminalExtraction {
  statusCode?:
    | { from: "property"; name: string } // { status: 200 } → name: "status"
    | { from: "argument"; position: number; minArgs?: number } // res.status(200) → position: 0
    | { from: "constructor"; codes: Record<string, number> }; // throw new NotFound() → 404 via { NotFound: 404 }
  body?:
    | { from: "property"; name: string } // { body: data } → name: "body"
    | { from: "argument"; position: number; minArgs?: number }; // res.json(data) → position: 0
  /** Fallback status code when none is extracted. e.g. Express res.json() defaults to 200. */
  defaultStatusCode?: number;
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
    }
  | {
      /**
       * Component props, React / Vue / Svelte-style: one parameter that
       * the caller destructures at will, with prop names only visible at
       * the call site. When the parameter is destructured, each bound
       * name becomes its own Input with role equal to the name. When
       * it's not destructured (e.g. `function X(props) {...}`), one
       * Input is emitted with `wholeParamRole` (default `"props"`).
       *
       * Differs from `destructuredObject` in that prop names are not
       * declared by the pack up-front — they are whatever the component
       * author wrote. Differs from `singleObjectParam` in that the
       * destructuring pattern is honored when present.
       */
      type: "componentProps";
      paramPosition: number;
      /** Role for the single Input when the param is not destructured. Defaults to "props". */
      wholeParamRole?: string;
    };

// =============================================================================
// Response property semantics
// =============================================================================

/**
 * What a property on the API response object semantically represents.
 * Declared in the pack so the adapter can resolve derived properties
 * (e.g. `.ok` → status range 200–299) at extraction time.
 */
export type ResponsePropertyMeaning =
  | { type: "statusCode" }
  | { type: "statusRange"; min: number; max: number }
  | { type: "body" }
  | { type: "headers" };

export interface ResponsePropertyMapping {
  /** Property or method name on the response (e.g. "ok", "status", "json") */
  name: string;
  /** How this member is accessed: property read or method call */
  access: "property" | "method";
  /** What the value semantically represents */
  semantics: ResponsePropertyMeaning;
}

// =============================================================================
// PatternPack
// =============================================================================

export interface PatternPack {
  name: string;
  languages: string[];
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  contractReading?: ContractPattern;
  inputMapping: InputMappingPattern;
  /**
   * Semantics of properties on the API response object (consumer side).
   * Tells the adapter how to resolve derived properties like `.ok` or
   * `.json()` to structured IR constructs instead of leaving them opaque.
   */
  responseSemantics?: ResponsePropertyMapping[];
}
