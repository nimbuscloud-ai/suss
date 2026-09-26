// The default VitePress theme, with a "Copy page as Markdown" button above
// each page and the styles the diagrams need. The diagrams are inline in the
// markdown so they follow the theme's colors in light and dark.

import DefaultTheme from "vitepress/theme";
import { h } from "vue";

import { CopyPageMarkdown } from "./copyPageMarkdown.js";

import type { Theme } from "vitepress";

import "./copyPageMarkdown.css";
import "./diagrams.css";

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "doc-before": () => h(CopyPageMarkdown),
    }),
} satisfies Theme;
