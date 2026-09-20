# ChatGPT Agents Tab Manager

A Manifest V3 Chrome/Edge extension that runs one ChatGPT browser agent at a time. The agent can operate a target web app through Chrome DevTools Protocol, inspect the current page, receive screenshots, choose the next safe browser action, and continue until its task is complete.

## V0.6 — autonomous browser agent + guided tutorial navigation

The extension now deliberately runs **one active agent at a time**.

For read-only audit tasks, the loop is:

```text
Task JSON
   ↓
ChatGPT agent
   ↓
BROWSER_ACTION JSON
   ↓
Extension browser operator
   ↓
Dynk/app tab
   ├── navigate
   ├── click safe links/buttons
   ├── scroll
   ├── inspect page text + interactive elements
   ├── back
   ├── wait
   └── capture current viewport
   ↓
Screenshot + structured browser observation
   ↓
same ChatGPT conversation
   ↓
next browser action
```

The user only needs to intervene for a true blocker such as login/MFA, CAPTCHA, an external authentication origin, permission denial, or browser policy restriction.



## Tutorial navigation

Tutorial tasks reuse the safe browser operator but add slower pacing, visible Guide mouse movement, captions, screenshot awareness, and safe dummy-data helpers. The extension does **not** record video.

Use:

`samples/highlevel-import-contacts-tutorial.json`

Recommended workflow:

1. Start OBS and choose your browser/window capture source.
2. Import the tutorial JSON.
3. Click **Start** in ChatGPT Agents.
4. The agent opens the configured app location and begins the walkthrough immediately.
5. The Guide pointer moves visibly, captions describe actions, and the agent pauses on important screens.
6. Tutorial mode can attach an in-memory dummy CSV with `upload_sample_csv`; it never needs real customer data.
7. The agent stays read-only and stops before a final submit/import/save action.

Tutorial task JSON supports:

```json
{
  "task_mode": "tutorial",
  "tutorial": {
    "enabled": true,
    "title": "How to Import Contacts in HighLevel",
    "pace": "guided"
  },
  "audit_mode": "tutorial read-only",
  "audit_target": {
    "url": "https://app.gohighlevel.com/"
  }
}
```

OBS handles recording quality, audio, canvas size, overlays, and final output. The extension only handles browser navigation and tutorial guidance.

## Screenshot-aware browser control

Autonomous audits and tutorials are screenshot-first. After every browser action, the extension captures the current viewport and attaches it to the ChatGPT conversation together with page text and a list of visible controls.

The agent can act directly from what it sees using normalized viewport coordinates:

```text
BROWSER_ACTION: {"type":"click_point","xPct":0.22,"yPct":0.41}
```

`xPct` and `yPct` run from 0 to 1 across the visible viewport, so the action remains stable across screen sizes and display scaling. Before clicking, the extension resolves the real DOM control under that point and blocks hidden, disabled, non-interactive, or obvious state-changing controls.

Detected controls also include normalized center coordinates as supporting evidence, but the screenshot is treated as the primary environment view.

## Read-only guard

Audit automation is intentionally non-destructive. The operator blocks obvious state-changing actions such as Save, Submit, Delete, Approve, Pay, Book Now, Activate, Refund, Send, Invite and similar controls.

Safe audit actions currently include:

- `inspect`
- `click_text`
- `click_selector`
- `click_point` using screenshot-relative coordinates
- `navigate` within the configured audit origin
- `scroll`
- `back`
- `wait`
- `capture`

The browser operator uses `chrome.debugger` / Chrome DevTools Protocol for page inspection, navigation and screenshots.

## Dynk autonomous audit

Use:

`samples/dynk-full-audit-autonomous.json`

Then:

1. Update/reload the extension.
2. Make sure you are already logged in to Dynk in the same Edge/Chrome profile.
3. Import the JSON.
4. Click **Start** once.
5. Leave the browser open. The same agent will drive the Dynk tab and keep working through the audit.
6. Intervene only if the side panel shows **Needs User**.

The old three-agent audit sample remains in the repository for reference, but the recommended workflow is now the single autonomous task.

## Automatic task JSON detection

The extension can detect task JSON directly in completed ChatGPT assistant responses, so you no longer need to save every generated task bundle to a file before importing it.

Default behavior:

- **Detect JSON: on**
- **Auto import: on**
- **Auto start: off**

Detected JSON is validated against the existing task schema before import. Generic JSON snippets are ignored. Each payload receives a stable fingerprint so the same generated bundle is not repeatedly imported after DOM mutations, refreshes, or extension reloads.

Automatic imports are conservative: if a detected task ID already exists, the extension leaves the existing task untouched. This protects completed/crossed-out subtasks from being reset by a repeated or regenerated task bundle.

The side panel shows the most recent detection result and exposes compact toggles for detection, auto import, and auto start.

## Local install

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Load unpacked from your local repository folder.
4. Click the extension action to open the side panel.

## Updating

If your live extension folder is:

`D:\chatgpt-agents-main\chatgpt-agents-main`

and it is a Git clone, update with:

```powershell
git -C "D:\chatgpt-agents-main\chatgpt-agents-main" pull --ff-only origin main
```

Then reload the extension from `edge://extensions`.

## Browser action protocol

Autonomous audit responses finish with:

```text
BROWSER_ACTION: {"type":"click_text","text":"Locations"}
AGENT_STATUS: CONTINUE
NEXT_ACTION: Open Locations and inspect it
```

When finished:

```text
BROWSER_ACTION: null
AGENT_STATUS: COMPLETE
NEXT_ACTION: Audit complete
```

## Key files

- `src/background/task-runner.js` — one-agent queue and autonomous loop
- `src/background/browser-operator.js` — read-only CDP browser controller + tutorial captions/pacing
- `src/tasks/prompt-builder.js` — agent/browser command contract
- `src/content/chatgpt-content.js` — ChatGPT prompt/image adapter
- `src/storage/repository.js` — durable state and v0.3 settings migration
- `samples/dynk-full-audit-autonomous.json` — recommended Dynk task
- `samples/highlevel-import-contacts-tutorial.json` — guided HighLevel tutorial example

## Development

```bash
npm test
```

The extension has no build step.

## Limitations

The ChatGPT web adapter depends on the current ChatGPT DOM, so selectors can occasionally require maintenance after ChatGPT UI changes.

The `debugger` permission is powerful and visible to the browser. Enterprise browser policies may prevent debugger attachment or screenshot capture.

Automation stays inside the configured audit origin and does not bypass authentication, permissions, CAPTCHA, application authorization, or browser security controls.
