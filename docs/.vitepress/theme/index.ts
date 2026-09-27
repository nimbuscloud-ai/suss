// The default VitePress theme, with a "Copy page as Markdown" button above
// each page, the agent setup prompts, and the diagram styles. The diagrams
// are inline in the markdown so they follow the theme's colors in dark mode.

import DefaultTheme from "vitepress/theme";
import { h } from "vue";

import { AgentPrompt, AgentPrompts } from "./agentPrompt.js";
import { CopyPageMarkdown } from "./copyPageMarkdown.js";

import type { Theme } from "vitepress";

import "./agentPrompt.css";
import "./copyButton.css";
import "./copyPageMarkdown.css";
import "./diagrams.css";

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "doc-before": () => h(CopyPageMarkdown),
    }),
  enhanceApp({ app }) {
    app.component("AgentPrompts", AgentPrompts);
    app.component("AgentPrompt", AgentPrompt);
  },
} satisfies Theme;
