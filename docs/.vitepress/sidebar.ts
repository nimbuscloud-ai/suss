/**
 * The editorial order of the site: run it for the first time, then a task,
 * then look something up. Theory comes last and starts collapsed, since
 * nobody needs it to use the tool.
 *
 * scripts/generateLlmsTxt.ts reads this too, so llms-full.txt concatenates
 * the pages in the order a reader meets them.
 */

export interface SidebarItem {
  text: string;
  link?: string;
  collapsed?: boolean;
  items?: SidebarItem[];
}

export const sidebar: SidebarItem[] = [
  {
    text: "Get started",
    collapsed: false,
    items: [
      { text: "Quickstart", link: "/start/quickstart" },
      {
        text: "Read a pull request",
        link: "/start/read-a-pull-request",
      },
      {
        text: "Give your agent suss",
        link: "/start/give-your-agent-suss",
      },
      { text: "Four ideas", link: "/start/four-ideas" },
    ],
  },
  {
    text: "Guides",
    collapsed: false,
    items: [
      { text: "Add suss to a project", link: "/guides/add-to-project" },
      { text: "Adopt it step by step", link: "/guides/adopting-suss" },
      { text: "Run suss in CI", link: "/guides/ci-integration" },
      { text: "Ask about a codebase", link: "/guides/ask" },
      {
        text: "Check against OpenAPI",
        link: "/guides/check-against-openapi",
      },
      {
        text: "Check against your intent",
        link: "/guides/check-against-intent",
      },
      { text: "Read Python or Ruby", link: "/guides/python-and-ruby" },
      {
        text: "Work across services",
        link: "/guides/work-across-services",
      },
      { text: "Accept a finding", link: "/guides/accept-a-finding" },
      {
        text: "Fix a run that found nothing",
        link: "/guides/fix-an-empty-run",
      },
      {
        text: "Teach suss a dependency",
        link: "/guides/teach-a-dependency",
      },
      { text: "Publish summaries", link: "/guides/publish-summaries" },
    ],
  },
  {
    text: "Packs",
    collapsed: false,
    items: [
      { text: "Pack catalog", link: "/packs/catalog" },
      { text: "What a pack is", link: "/packs/what-a-pack-is" },
      { text: "Write a pack", link: "/packs/write-a-pack" },
      { text: "Pack patterns", link: "/packs/patterns" },
      { text: "Contract sources", link: "/packs/contract-sources" },
    ],
  },
  {
    text: "Reference",
    collapsed: false,
    items: [
      {
        text: "CLI",
        collapsed: false,
        items: [
          { text: "Overview", link: "/reference/cli/" },
          { text: "suss init", link: "/reference/cli/init" },
          { text: "suss extract", link: "/reference/cli/extract" },
          { text: "suss contract", link: "/reference/cli/contract" },
          { text: "suss check", link: "/reference/cli/check" },
          { text: "suss inspect", link: "/reference/cli/inspect" },
          { text: "suss ask", link: "/reference/cli/ask" },
          {
            text: "suss corroborate",
            link: "/reference/cli/corroborate",
          },
          { text: "suss infer", link: "/reference/cli/infer" },
          { text: "Exit codes", link: "/reference/cli/exit-codes" },
        ],
      },
      { text: "Findings catalog", link: "/reference/findings" },
      { text: "Summary format", link: "/reference/summary-format" },
      { text: "IR types", link: "/reference/ir" },
      { text: "Compatibility", link: "/reference/compatibility" },
      { text: "Glossary", link: "/reference/glossary" },
      { text: "FAQ", link: "/reference/faq" },
      { text: "Changelog", link: "/reference/changelog" },
    ],
  },
  {
    text: "Why suss",
    collapsed: false,
    items: [
      { text: "The problem", link: "/why/the-problem" },
      { text: "Compared to other tools", link: "/why/compared" },
      {
        text: "Cross-boundary checking",
        link: "/why/cross-boundary-checking",
      },
      { text: "Kinds of contract", link: "/why/kinds-of-contract" },
    ],
  },
  {
    // How the pieces are built, for contributors. Design records
    // live in design/ at the repository root instead.
    text: "Theory",
    collapsed: true,
    items: [
      { text: "Architecture", link: "/theory/architecture" },
      {
        text: "Boundary semantics",
        link: "/theory/boundary-semantics",
      },
      { text: "Pipelines", link: "/theory/pipelines" },
      {
        text: "Extraction algorithm",
        link: "/theory/extraction-algorithm",
      },
      {
        text: "How suss follows a value",
        link: "/theory/resolving-values",
      },
      { text: "Facts and rules", link: "/theory/facts-and-rules" },
      {
        text: "Protocol assumptions",
        link: "/theory/protocol-assumptions",
      },
      { text: "Prior art", link: "/theory/prior-art" },
    ],
  },
];
