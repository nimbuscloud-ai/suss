// Exercises Phase 1.5 handler synthesis:
//   - `onSubmit={handleSubmit}` where handleSubmit is declared locally →
//     should produce a handler summary named `Form.handleSubmit`.
//   - `onClick={props.onDelete}` → delegates to a prop, NOT our handler;
//     should NOT produce a handler summary.
//   - Two inline `onClick={() => ...}` on two different buttons → two
//     anonymous handler summaries with `#N` disambiguation.

import { useState } from "react";

interface FormProps {
  onSubmit: (name: string) => void;
  onDelete: () => void;
}

export default function Form(props: FormProps) {
  const [name, setName] = useState("");

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    props.onSubmit(name);
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <button type="submit" onClick={() => setName("")}>
        Clear
      </button>
      <button type="button" onClick={() => setName("reset")}>
        Reset
      </button>
      <button type="button" onClick={props.onDelete}>
        Delete
      </button>
    </form>
  );
}
