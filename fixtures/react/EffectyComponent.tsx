// Exercises Phase 1.7 useEffect-as-code-unit synthesis:
//   - `useEffect(fn, [])` → effect summary index 0, deps []
//   - `useEffect(fn, [userId])` → effect summary index 1, deps ["userId"]
//   - `useEffect(fn)` (no deps array) → effect summary index 2, deps null
//
// The effect bodies are thin — Phase 1.5b will enrich them with bare
// call-statement effects. For now, each is a handler-kind summary with
// a default `return` transition and react metadata.

import { useEffect, useState } from "react";

interface Props {
  userId: string;
}

export default function EffectyComponent({ userId }: Props) {
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    setValue("loaded");
  }, []);

  useEffect(() => {
    setValue(`loaded: ${userId}`);
  }, [userId]);

  useEffect(() => {
    setValue(`rendered: ${value}`);
  });

  return <div>{value}</div>;
}
