// Handlers written as arrows without braces, which is how most inline
// React callbacks are written:
//   - `buildRow` hands back an object literal, so its summary carries
//     the whole record.
//   - `dismiss` is written for the side effect, so its summary carries
//     the return the arrow makes without a value.

import { useState } from "react";

interface RowBuilderProps {
  label: string;
}

export default function RowBuilder({ label }: RowBuilderProps) {
  const [open, setOpen] = useState(false);

  const buildRow = () => ({
    label,
    open,
    kind: "row",
    editable: true,
    weight: 1,
  });
  const dismiss = () => setOpen(false);

  return (
    <div>
      <button type="button" onClick={buildRow}>
        Build
      </button>
      <button type="button" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
