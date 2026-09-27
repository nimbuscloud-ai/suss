/**
 * Setup prompts for coding agents, one tab per agent. Each tab shows a line
 * saying what its prompt does, a button that copies the prompt, and the
 * prompt folded away in a <details> element. The prompt is the fenced code
 * block the page puts inside <AgentPrompt>, so the page's markdown copy and
 * check:examples read the same text the button copies.
 *
 * The tab bar borrows VitePress's code group classes for its look. The
 * panels are outside that element, because VitePress's own tab switching
 * and its rule that hides inactive code blocks would otherwise reach into
 * them. Without JavaScript the first tab shows, and its prompt still opens.
 */

import { cloneVNode, defineComponent, h, ref, useId, type VNode } from "vue";

import { CopyButton } from "./copyButton.js";

export const AgentPrompt = defineComponent({
  name: "AgentPrompt",
  props: {
    agent: { type: String, required: true },
    description: { type: String, required: true },
  },
  setup(props, { slots }) {
    const details = ref<HTMLDetailsElement | null>(null);

    // The same text the code block's own copy button would take.
    async function copy(): Promise<void> {
      const prompt = details.value?.querySelector("pre")?.textContent;
      if (!prompt) {
        throw new Error(`there is no prompt for ${props.agent}`);
      }
      await navigator.clipboard.writeText(prompt);
    }

    return () =>
      h("div", { class: "agent-prompt" }, [
        h("div", { class: "agent-prompt-head" }, [
          h("p", null, props.description),
          h(CopyButton, {
            label: "Copy prompt",
            failedLabel: "Could not copy the prompt",
            copy,
          }),
        ]),
        h("details", { ref: details }, [
          h("summary", null, [
            h("span", { class: "agent-prompt-show" }, "Show the prompt"),
            h("span", { class: "agent-prompt-hide" }, "Hide the prompt"),
          ]),
          slots.default?.(),
        ]),
      ]);
  },
});

function isAgentPrompt(node: VNode): boolean {
  return node.type === AgentPrompt;
}

export const AgentPrompts = defineComponent({
  name: "AgentPrompts",
  setup(_props, { slots }) {
    const group = useId();
    const selected = ref(0);

    function tab(prompt: VNode, index: number): VNode[] {
      const id = `${group}-${index}`;
      const agent = String(prompt.props?.agent);
      return [
        h("input", {
          type: "radio",
          name: group,
          id,
          checked: index === selected.value,
          onChange: () => {
            selected.value = index;
          },
        }),
        h("label", { for: id, "data-title": agent }, agent),
      ];
    }

    return () => {
      const prompts = (slots.default?.() ?? []).filter(isAgentPrompt);
      return h("div", { class: "agent-prompts" }, [
        h("div", { class: "vp-code-group" }, [
          h("div", { class: "tabs" }, prompts.flatMap(tab)),
        ]),
        ...prompts.map((prompt, index) =>
          cloneVNode(prompt, { hidden: index !== selected.value }),
        ),
      ]);
    };
  },
});
