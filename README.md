# Castkeeper for SillyTavern

An editable cast of supporting characters for each story. Castkeeper detects relevant NPCs, records what the story establishes, and helps the model remember them. Unknown details stay empty unless you choose to invent them.

Targets **SillyTavern 1.19.0 or later**. Uses your currently selected AI connection, including its available chat, character, and lore context. No server plugin, extra API key, runtime dependency, or build step is required. This is a standalone implementation; NPC State is not a dependency.

## Install

### Local folder or ZIP

1. Extract `SillyTavern-Castkeeper-1.0.2.zip`, or use the `dist/SillyTavern-Castkeeper` folder produced by `npm run package`.
2. Copy that folder into **one** of these locations inside your SillyTavern installation:
   - Current user: `data/<your-user-handle>/extensions/SillyTavern-Castkeeper`
   - All users: `public/scripts/extensions/third-party/SillyTavern-Castkeeper`
3. Make sure `manifest.json` is directly inside that folder, not in a second nested folder.
4. Reload SillyTavern, open a chat, and connect an AI model. Open **Extensions → Castkeeper** for settings. The **Castkeeper** button is also in the chat extensions menu.

For development, this repository itself is the extension folder: copy or symlink it into one of those locations. Do not run `npm install` inside SillyTavern just to use the extension.

### Git installer

In SillyTavern, open **Extensions → Install extension** and paste:

```text
https://github.com/Diamond-Shark-art/SillyTavern-Castkeeper
```

Reload SillyTavern after installation. Updates can be pulled through SillyTavern's extension manager.

Prefer a local installation? Download the ZIP from [Releases](https://github.com/Diamond-Shark-art/SillyTavern-Castkeeper/releases/latest) and follow the folder instructions above.

## Version 1.0.2

- Scans now cite numbered passages instead of requiring the model to reproduce exact quotations. Older quote responses also tolerate whitespace, emphasis and quotation-mark differences.
- One unverifiable field or NPC no longer discards the rest of a valid scan. Verified profiles are saved, with skipped items explained under **Scan details** and a **Retry** action.
- Scan status reports profiles created or updated, or says when no relevant NPCs were found.
- The wand-menu entry now uses SillyTavern's native icon-and-text row, with keyboard support.

## Version 1.0.1

- Fixed scanning and manual profile creation on HTTP/LAN installations where `crypto.randomUUID()` is unavailable.
- Settings now use SillyTavern's native extension drawer and theme styling.
- Removed duplicate action errors and isolated dialog headings from global theme decorations.

To update a Git installation, open **Extensions → Manage extensions**, update Castkeeper, and reload the page. Existing settings and profiles are preserved.

## Use

- **Automatic detection** is on by default. After a completed assistant reply, the extension scans the latest assistant response and preceding user messages. It tracks individually relevant NPCs, including distinct unnamed characters such as an interacting bartender. It excludes the player, active character cards, crowds, and passing mentions.
- **Scan recent messages** manually checks up to six non-system messages ending at the latest assistant response. It does not backfill the entire chat.
- Open a profile to edit its name, aliases, species, race/ancestry, body description, skin/covering color, short backstory, likes, dislikes, and traits. Lists use one item per line, with a maximum of 12 items each.
- Editing a field automatically locks it. To allow later model updates, save your edit, then uncheck its lock and save again. An intentionally cleared, locked field stays empty.
- **Generate missing details** produces suggestions for empty, unlocked fields. Nothing is saved until you choose **Apply selected suggestions**. Edit or deselect suggestions first. Suggestions you rewrite become locked manual edits. Names and aliases are never creatively generated.
- **Automatically complete new profiles** is off by default. Enable it to save generated additions directly for newly encountered NPCs. Existing facts and locked fields are preserved.
- **From story**, **Generated**, and **Edited** labels show where each value came from. Hover over a story label to inspect its source excerpts.
- **Delete profile** removes the profile from the list and suppresses automatic recreation under its name/aliases. Creating a new manual profile with that name explicitly permits tracking it again.

Each chat has its own library. Profiles survive reloads. NPCs whose originating encounter was removed remain listed as **Inactive encounter**, with manual corrections preserved; their obsolete story facts are removed and they are not injected. They can become active when encountered again. “In this story” means the profile has a surviving encounter, not necessarily that the NPC is currently in the room.

### Context and request cost

Normal detection uses one additional model request per completed reply. Automatic creative completion can add one more for the new NPCs from that scan. Manual scans and generation each use one request; no automatic retries are made.

The saved profiles relevant to the latest exchange or pending user message are supplied to future replies, with a **1,000-token** default budget. Pending-message matches take priority. Whole fields that do not fit are omitted; the profile itself is retained. The token budget covers profile injection, not the separate scanner request, which uses SillyTavern's available chat/lore context and a 4,096-token response ceiling.

Quiet requests are serialized. A new ordinary generation waits for a running profile request to finish so both do not use the host connection simultaneously. Failed scans expose **Retry** and do not prevent ordinary chatting with the last valid profiles. Use SillyTavern's stop control to cancel a stuck generation. Disabling detection alone stops future automatic scans; disabling the extension also invalidates pending results and clears injected context.

## Try it

Use a narrator-style character and start a new chat. Ask for a scene containing:

> Mira, a human bartender with olive skin and a sturdy build, greets me. She likes gardening, dislikes loud arguments, and is patient. A silver-scaled dragon named Ember lands nearby. An unnamed watchman offers me directions. A crowd passes outside.

After the model's response:

1. Open **Castkeeper**. Expect relevant individuals from the actual reply, not the crowd or your own persona.
2. Check that supported appearance and personality details were recorded, while unrevealed ancestry and backstory remain empty.
3. Generate missing details for Mira. Edit a suggested backstory and apply it; verify that it is labeled **Edited** and locked.
4. Continue the story and confirm those details persist. Reopen the chat to check persistence.
5. Swipe or delete the encounter. Its story-derived facts should disappear, its manual corrections should remain, and an NPC with no surviving encounter should become inactive.

Detection and interpretation depend on the selected model. The extension checks JSON structure, permitted fields, identity anchors, and citations against the scanned passages. Citations preserve the original story text but cannot prove that an LLM interpreted it correctly. Unverifiable fields or encounters are skipped and reported; malformed JSON or an invalid top-level response changes nothing. Use editing and locks for corrections. Small models may require a retry or a manual profile.

## Development and validation

```sh
npm ci
npm run check
npm test
npm run test:ui
npm run package
```

Node.js 22+ is required only for development. Browser tests use the installed Google Chrome channel through Playwright; install Chrome or change `channel` in `playwright.config.js` to your available Playwright browser. Packaging uses the `zip` command. The distributable contains only runtime files, this README, and the license.

Tests cover extraction, source validation, aliases, ambiguous identities, non-human profiles, manual edits/locks, generation previews, malformed responses, request failures, event deduplication, streaming, history changes, chat switches, cancellation, metadata persistence, injection budgets, and desktop/mobile browser workflows. The browser fixture is a mocked SillyTavern host; it never calls a model. **A live SillyTavern installation and real provider have not been tested in this workspace.**

### Implementation notes

- `src/model.js`: pure validation, field provenance, profile projection, history reconciliation, and context selection.
- `src/engine.js`: SillyTavern adapter, serialized jobs, lifecycle events, stale-result guards, metadata persistence, and prompt injection.
- `src/prompts.js` and `src/ui.js`: extraction/completion instructions and accessible native dialog UI.
- State uses `chatMetadata.npc_profiles` with `version: 1`. Settings use `extensionSettings.npc_profiles`.
- Extracted/generated changes are journaled against the source message and a fingerprint of the preceding history. Editing earlier history invalidates dependent later changes; unaffected earlier events survive. Manual corrections have their own sequence and locks. Deleted NPC records remain as tombstones.
- A changed source, chat, connection, or profile revision invalidates in-flight results and previews. Unsupported saved-state versions fail visibly without overwriting data.
- Scalar story facts can update unlocked values. Supported list facts accumulate up to 12 items; remove obsolete list items manually. Generated list suggestions can be replaced by later established facts.
- Persistence uses SillyTavern's `saveMetadata()`. The host handles server save errors and may not propagate them to extensions, so this extension cannot independently guarantee server acknowledgement. Watch for SillyTavern's own save errors.
- No cross-chat sharing, portrait generation, RPG statistics, character-card export, historical backfill, or public integration API is included in v1.

References: [SillyTavern extension API](https://docs.sillytavern.app/for-contributors/writing-extensions/) and [release context API](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/st-context.js).
