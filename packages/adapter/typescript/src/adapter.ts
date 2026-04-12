// adapter.ts — Full adapter orchestration (Task 2.5b)
//
// Wires together: discovery → extractCodeStructure → readContract → assembleSummary

import { Node, Project, type SourceFile } from "ts-morph";

import {
  assembleSummary,
  type ExtractorOptions,
  type FrameworkPack,
  type InputMappingPattern,
  type RawCodeStructure,
  type RawDependencyCall,
  type RawParameter,
} from "@suss/extractor";

import { extractRawBranches } from "./assembly.js";
import { readContract } from "./contract.js";
import { type DiscoveredUnit, discoverUnits } from "./discovery.js";

import type { BehavioralSummary, CodeUnitKind } from "@suss/behavioral-ir";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Parameter extraction
// ---------------------------------------------------------------------------

function extractParameters(
  func: FunctionRoot,
  inputMapping: InputMappingPattern,
): RawParameter[] {
  const params = func.getParameters();
  const result: RawParameter[] = [];

  if (inputMapping.type === "positionalParams") {
    for (const mapping of inputMapping.params) {
      const param = params[mapping.position];
      if (param === undefined) {
        continue;
      }
      result.push({
        name: param.getName(),
        position: mapping.position,
        role: mapping.role,
        typeText: null,
      });
    }
  } else if (inputMapping.type === "singleObjectParam") {
    const param = params[inputMapping.paramPosition];
    if (param !== undefined) {
      result.push({
        name: param.getName(),
        position: inputMapping.paramPosition,
        role: "request",
        typeText: null,
      });
    }
  } else if (inputMapping.type === "destructuredObject") {
    const param = params[0];
    if (param !== undefined) {
      const nameNode = param.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) {
        for (const element of nameNode.getElements()) {
          const name = element.getName();
          const role = inputMapping.knownProperties[name] ?? name;
          result.push({ name, position: 0, role, typeText: null });
        }
      } else {
        // Non-destructured: treat as a single object parameter
        result.push({
          name: param.getName(),
          position: 0,
          role: "request",
          typeText: null,
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Dependency-call extraction
// ---------------------------------------------------------------------------

function extractDependencyCalls(func: FunctionRoot): RawDependencyCall[] {
  const results: RawDependencyCall[] = [];

  func.forEachDescendant((node, traversal) => {
    // Don't descend into nested functions — their dep calls belong to them
    if (
      node !== func &&
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node))
    ) {
      traversal.skip();
      return;
    }

    if (!Node.isVariableDeclaration(node)) {
      return;
    }

    const init = node.getInitializer();
    if (init === undefined) {
      return;
    }

    let isAsync = false;
    let callExpr = init;
    if (Node.isAwaitExpression(init)) {
      isAsync = true;
      callExpr = init.getExpression();
    }

    if (!Node.isCallExpression(callExpr)) {
      return;
    }

    const calleeName = callExpr.getExpression().getText();

    // assignedTo: simple identifier or destructured pattern
    const nameNode = node.getNameNode();
    const assignedTo = Node.isIdentifier(nameNode) ? nameNode.getText() : null;

    // VariableDeclaration → VariableDeclarationList → VariableStatement
    const declList = node.getParent();
    const varStmt = declList?.getParent();
    const locationNode =
      varStmt !== undefined && Node.isVariableStatement(varStmt)
        ? varStmt
        : node;

    results.push({
      name: calleeName,
      assignedTo,
      async: isAsync,
      returnType: null,
      location: {
        start: locationNode.getStartLineNumber(),
        end: locationNode.getEndLineNumber(),
      },
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Code structure extraction (per unit)
// ---------------------------------------------------------------------------

export function extractCodeStructure(
  unit: DiscoveredUnit,
  pack: FrameworkPack,
  filePath: string,
): RawCodeStructure {
  const { func, kind, name } = unit;
  const params = extractParameters(func, pack.inputMapping);
  const branches = extractRawBranches(func, pack.terminals);
  const depCalls = extractDependencyCalls(func);

  return {
    identity: {
      name,
      kind: kind as CodeUnitKind,
      file: filePath,
      range: {
        start: func.getStartLineNumber(),
        end: func.getEndLineNumber(),
      },
      exportName: name,
      exportPath: [name],
    },
    boundaryBinding: null,
    parameters: params,
    branches,
    dependencyCalls: depCalls,
    declaredContract: null,
  };
}

// ---------------------------------------------------------------------------
// Per-file extraction
// ---------------------------------------------------------------------------

function extractFromSourceFile(
  sourceFile: SourceFile,
  frameworks: FrameworkPack[],
  options?: ExtractorOptions,
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  const filePath = sourceFile.getFilePath();

  for (const pack of frameworks) {
    const units = discoverUnits(sourceFile, pack.discovery);

    for (const unit of units) {
      const raw = extractCodeStructure(unit, pack, filePath);

      // Attempt contract reading
      if (pack.contractReading !== undefined) {
        const contract = readContract(unit, pack.contractReading);
        if (contract !== null) {
          raw.declaredContract = contract.declaredContract;
          if (contract.boundaryBinding !== null) {
            raw.boundaryBinding = contract.boundaryBinding;
          }
        }
      }

      // Fill in a default boundary binding if none from contract
      if (raw.boundaryBinding === null) {
        raw.boundaryBinding = {
          protocol: "http",
          framework: pack.name,
        };
      }

      summaries.push(assembleSummary(raw, options));
    }
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// Public adapter API
// ---------------------------------------------------------------------------

export interface TypeScriptAdapterConfig {
  tsConfigFilePath?: string;
  project?: Project;
  frameworks: FrameworkPack[];
  extractorOptions?: ExtractorOptions;
}

export interface TypeScriptAdapter {
  project: Project;
  extractFromFiles(filePaths: string[]): BehavioralSummary[];
  extractAll(): BehavioralSummary[];
}

export function createTypeScriptAdapter(
  config: TypeScriptAdapterConfig,
): TypeScriptAdapter {
  const project =
    config.project ??
    new Project(
      config.tsConfigFilePath !== undefined
        ? { tsConfigFilePath: config.tsConfigFilePath }
        : { skipAddingFilesFromTsConfig: true },
    );

  return {
    project,

    extractFromFiles(filePaths: string[]): BehavioralSummary[] {
      const summaries: BehavioralSummary[] = [];

      for (const fp of filePaths) {
        const sourceFile = project.getSourceFile(fp);
        if (sourceFile === undefined) {
          continue;
        }
        summaries.push(
          ...extractFromSourceFile(
            sourceFile,
            config.frameworks,
            config.extractorOptions,
          ),
        );
      }

      return summaries;
    },

    extractAll(): BehavioralSummary[] {
      const summaries: BehavioralSummary[] = [];

      for (const sourceFile of project.getSourceFiles()) {
        if (sourceFile.isDeclarationFile()) {
          continue;
        }
        summaries.push(
          ...extractFromSourceFile(
            sourceFile,
            config.frameworks,
            config.extractorOptions,
          ),
        );
      }

      return summaries;
    },
  };
}
