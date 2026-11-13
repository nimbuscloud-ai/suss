// A handler memoized with useCallback and handed to the button by name.
// React runs it when the button is clicked, not while SaveBar renders.

import { useCallback, useState } from "react";

export function SaveBar({ onSave }: { onSave: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    await onSave();
    setSaving(false);
  }, [onSave]);

  return (
    <button type="button" onClick={save} disabled={saving}>
      Save
    </button>
  );
}
