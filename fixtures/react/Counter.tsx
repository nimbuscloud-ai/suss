// Component with multiple destructured props and a useState hook.
// Phase 1.2 should produce:
//   - Inputs for each destructured prop: label, initial, onChange
//   - A dependency call capturing `useState(initial)` — the existing
//     dependencyCall extractor already handles `const x = fn(...)`,
//     so hooks get picked up for free as long as the variable-
//     declaration pattern matches.
// Conditional rendering (`count > 0 && ...`) is phase 1.4; here only
// the unconditional return is tested.

import { useState } from "react";

export default function Counter({
  label,
  initial,
  onChange,
}: {
  label: string;
  initial: number;
  onChange: (next: number) => void;
}) {
  const [count, setCount] = useState(initial);
  return (
    <div>
      <span>{label}</span>
      <button
        type="button"
        onClick={() => {
          const next = count + 1;
          setCount(next);
          onChange(next);
        }}
      >
        {count}
      </button>
    </div>
  );
}
