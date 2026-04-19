// Glossary of symbolic terms that appear in docs prose — inline-code
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
  // IR types — /ir-reference
  BehavioralSummary: "/ir-reference#behavioralsummary",
  CodeUnitKind: "/ir-reference#codeunitkind",
  SourceLocation: "/ir-reference#sourcelocation-and-codeunitidentity",
  CodeUnitIdentity: "/ir-reference#sourcelocation-and-codeunitidentity",
  BoundaryBinding: "/ir-reference#boundarybinding",
  Transition: "/ir-reference#transition",
  Predicate: "/ir-reference#predicate",
  ValueRef: "/ir-reference#valueref",
  Output: "/ir-reference#output",
  TypeShape: "/ir-reference#typeshape",
  Effect: "/ir-reference#effect",
  Input: "/ir-reference#input",
  Gap: "/ir-reference#gap",
  ConfidenceInfo: "/ir-reference#confidenceinfo",
  Finding: "/ir-reference#finding",
  RawCodeStructure: "/ir-reference#rawcodestructure",

  // Boundary-semantics concepts — /boundary-semantics
  BoundarySemantics: "/boundary-semantics",

  // Framework-pack types — /framework-packs
  PatternPack: "/framework-packs#what-a-pack-describes",
  DiscoveryMatch: "/framework-packs#discoverymatch-variants",
  BindingExtraction: "/framework-packs#bindingextraction",
  TerminalMatch: "/framework-packs#terminalmatch-variants",
  TerminalExtraction: "/framework-packs#terminalextraction",
  InputMappingPattern: "/framework-packs#inputmappingpattern-variants",
};
