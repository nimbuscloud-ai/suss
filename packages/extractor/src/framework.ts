// @suss/extractor — FrameworkPack interface

export type DiscoveryMatch =
  | { kind: "namedExport"; names: string[] }
  | { kind: "registrationCall"; importModule: string; registrationChain: string[] }
  | { kind: "decorator"; name: string }
  | { kind: "fileConvention"; filePattern: string; exportNames: string[] };

export interface BindingExtraction {
  methodSource: string;
  pathSource: string;
}

export interface DiscoveryPattern {
  kind: string;
  match: DiscoveryMatch;
  bindingExtraction?: BindingExtraction;
}

export type TerminalMatch =
  | { kind: "returnShape"; requiredProperties?: string[] }
  | { kind: "parameterMethodCall"; paramPosition: number; methodChain: string[] }
  | { kind: "throwExpression"; constructorPattern?: string };

export interface TerminalExtraction {
  statusCode: { from: "property" | "argument"; name?: string; position?: number };
  body: { from: "property" | "argument"; name?: string; position?: number };
}

export interface TerminalPattern {
  kind: string;
  match: TerminalMatch;
  extraction: TerminalExtraction;
}

export interface ContractPattern {
  discovery: DiscoveryPattern;
  responseExtraction: { property: string };
  paramsExtraction?: { property: string };
}

export type InputMappingPattern =
  | { style: "singleObjectParam"; position: number; fields: string[] }
  | { style: "positionalParams"; params: Array<{ position: number; role: string }> }
  | { style: "destructuredObject"; fields: string[] };

export interface FrameworkPack {
  name: string;
  languages: string[];
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  contractReading?: ContractPattern;
  inputMapping: InputMappingPattern;
}
