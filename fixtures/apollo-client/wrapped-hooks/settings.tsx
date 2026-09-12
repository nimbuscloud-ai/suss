// A component whose document comes from another module, through the
// same project hook.

import { useAppQuery } from "./hooks.js";
import { SETTINGS_QUERY } from "./documents.js";

export function SettingsPanel({ region }: { region: string }) {
  const { data } = useAppQuery(SETTINGS_QUERY, { variables: { region } });
  return data;
}
