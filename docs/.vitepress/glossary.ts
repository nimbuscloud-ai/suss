// Glossary of symbolic terms that appear in docs prose, inline-code
// occurrences (`BehavioralSummary`, `BoundaryBinding`, …) get auto-linked
// to their canonical definition in the reference pages via
// plugins/glossary-link.ts.
//
// Keys are the exact identifier spelling as it appears in backticks in
// docs; values are site-absolute URLs (without the VitePress base) that
// point at the heading where the type is defined. Headings use
// markdown-it anchor slugs (lowercase, non-alphanumerics stripped,
// spaces turned into hyphens).

export const glossary: Record<string, string> = {
  // IR types: /reference/ir
  BehavioralSummary: "/reference/ir#behavioralsummary",
  CodeUnitKind: "/reference/ir#codeunitkind",
  SourceLocation: "/reference/ir#sourcelocation-and-codeunitidentity",
  CodeUnitIdentity: "/reference/ir#sourcelocation-and-codeunitidentity",
  BoundaryBinding: "/reference/ir#boundarybinding",
  Transition: "/reference/ir#transition",
  Predicate: "/reference/ir#predicate",
  ValueRef: "/reference/ir#valueref",
  Output: "/reference/ir#output",
  TypeShape: "/reference/ir#typeshape",
  Effect: "/reference/ir#effect",
  Input: "/reference/ir#input",
  Gap: "/reference/ir#gap",
  ConfidenceInfo: "/reference/ir#confidenceinfo",
  Finding: "/reference/ir#finding",
  RawCodeStructure: "/reference/ir#rawcodestructure",

  // Boundary-semantics concepts: /theory/boundary-semantics
  BoundarySemantics: "/theory/boundary-semantics",

  // Pack pattern types: /packs/patterns
  PatternPack: "/packs/patterns#the-patternpack-interface",
  DiscoveryMatch: "/packs/patterns#discoverymatch-variants",
  BindingExtraction: "/packs/patterns#bindingextraction",
  TerminalMatch: "/packs/patterns#terminalmatch-variants",
  TerminalExtraction: "/packs/patterns#terminalextraction",
  InputMappingPattern: "/packs/patterns#inputmappingpattern-variants",
};
