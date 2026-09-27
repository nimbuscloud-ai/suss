/**
 * The "Copy page as Markdown" button above every docs page. The docs build
 * writes each page's markdown next to its HTML, at the same path as the
 * source file, and this copies that file so a reader can paste the page
 * into an agent. `vitepress dev` serves no such file, so there it fails.
 */

import { useData, withBase } from "vitepress";
import { defineComponent, h } from "vue";

import { CopyButton } from "./copyButton.js";

async function markdownAt(relativePath: string): Promise<Blob> {
  const response = await fetch(withBase(`/${relativePath}`));
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !/markdown|text\/plain/.test(type)) {
    throw new Error(`no markdown for ${relativePath}`);
  }
  return new Blob([await response.text()], { type: "text/plain" });
}

async function writeClipboard(markdown: Promise<Blob>): Promise<void> {
  // Safari only lets a click write to the clipboard if the write starts
  // before the first await, so the fetch goes in as a pending item.
  if (typeof ClipboardItem !== "undefined") {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": markdown }),
    ]);
    return;
  }

  await navigator.clipboard.writeText(await (await markdown).text());
}

export const CopyPageMarkdown = defineComponent({
  name: "CopyPageMarkdown",
  setup() {
    const { page } = useData();

    function copy(): Promise<void> {
      return writeClipboard(markdownAt(page.value.relativePath));
    }

    return () =>
      h("div", { class: "copy-page-markdown" }, [
        h(CopyButton, {
          label: "Copy page as Markdown",
          failedLabel: "Could not copy the page",
          copy,
        }),
      ]);
  },
});
