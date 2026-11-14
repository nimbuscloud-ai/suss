// An inline handler written in parentheses.

import { useState } from "react";

export function Toast({ text }: { text: string }) {
  const [open, setOpen] = useState(true);

  if (!open) {
    return null;
  }
  return (
    <div role="alert">
      {text}
      <button type="button" onClick={(() => setOpen(false))}>
        Dismiss
      </button>
    </div>
  );
}
