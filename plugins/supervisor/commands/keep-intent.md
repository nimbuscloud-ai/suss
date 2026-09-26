---
description: Keep this session's change list as boundary intent documents in intent/, for the team to check the code against from now on.
argument-hint: "[who calls these boundaries]"
---

Turn this session's change list into boundary intent documents in the project's `intent/` folder.

1. Find the change list. It is `.suss/session/${CLAUDE_SESSION_ID}/intent.yaml`. When a stop has passed since it was written, suss has filed it away, and it is the newest file in `.suss/session/${CLAUDE_SESSION_ID}/intents/`.
2. Work out who calls these boundaries, for the documents' `audience`. Use "$ARGUMENTS" when it is not empty. Otherwise use the developer's words if they said, and ask the developer when you do not know.
3. Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" intent keep <change list> --dir .suss/session/${CLAUDE_SESSION_ID}/state/current --audience "<who calls them>" --into intent
   ```

4. Tell the developer which files it wrote and what it left out. Each document takes the request as its `purpose` and each outcome's condition from the code as it is now. Ask them to read each `when` and to rename the outcome ids to what the team calls them.
