---
description: Keep this session's change list as boundary intent documents in intent/, for the team to check the code against from now on.
argument-hint: "[who calls these boundaries]"
---

Turn this session's change list into boundary intent documents in the project's `intent/` folder.

1. Work out who calls these boundaries, for the documents' `audience`. Use "$ARGUMENTS" when it is not empty. Otherwise use the developer's words if they said, and ask the developer when you do not know.
2. Run this from the project directory:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/keepIntent.mjs" --session "${CLAUDE_SESSION_ID}" --audience "<who calls them>"
   ```

   The script finds the change list and the summaries itself. When the session id is not filled in, it uses the session the suss hooks last saw.
3. Tell the developer which files it wrote and what it left out. Each document takes the request as its `purpose` and each outcome's condition from the code as it is now. Ask them to read each `when` and to rename the outcome ids to what the team calls them.
