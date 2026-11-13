// An embedded widget written against Preact's hooks. Its useEffect is
// Preact's, not React's.

import { useEffect, useState } from "preact/hooks";

export function Clock({ zone }: { zone: string }) {
  const [now] = useState(() => new Date());

  useEffect(() => {
    document.title = `${zone}: ${now.toISOString()}`;
  }, [zone]);

  return <time>{now.toISOString()}</time>;
}
