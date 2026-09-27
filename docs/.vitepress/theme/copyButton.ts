/**
 * A button that copies something to the clipboard, then says "Copied" or
 * that the copy failed for two seconds before showing its label again. The
 * "Copy page as Markdown" button and each setup prompt's "Copy prompt"
 * button are this one, given a different label and a different copy.
 */

import { defineComponent, h, onBeforeUnmount, type PropType, ref } from "vue";

type CopyState = "idle" | "copied" | "failed";

const CONFIRMATION_MS = 2000;

export const CopyButton = defineComponent({
  name: "CopyButton",
  props: {
    label: { type: String, required: true },
    failedLabel: { type: String, required: true },
    copy: { type: Function as PropType<() => Promise<void>>, required: true },
  },
  setup(props) {
    const state = ref<CopyState>("idle");
    let reset: ReturnType<typeof setTimeout> | undefined;

    function labels(): Record<CopyState, string> {
      return { idle: props.label, copied: "Copied", failed: props.failedLabel };
    }

    async function onClick(): Promise<void> {
      try {
        await props.copy();
        state.value = "copied";
      } catch {
        state.value = "failed";
      }
      clearTimeout(reset);
      reset = setTimeout(() => {
        state.value = "idle";
      }, CONFIRMATION_MS);
    }

    onBeforeUnmount(() => {
      clearTimeout(reset);
    });

    return () =>
      h(
        "button",
        {
          type: "button",
          class: "copy-button",
          "aria-live": "polite",
          onClick,
        },
        labels()[state.value],
      );
  },
});
