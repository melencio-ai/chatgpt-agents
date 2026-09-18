# ChatGPT Agents Tab Manager

A Manifest V3 Chrome/Edge extension that runs one ChatGPT browser agent at a time. The agent can operate a target web app through Chrome DevTools Protocol, inspect the current page, receive screenshots, choose the next safe browser action, and continue until its task is complete.

## V0.5 — autonomous browser agent + tutorial recorder

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



## Tutorial recorder

Tutorial tasks reuse the safe browser operator but add recording-oriented pacing and captions. The extension records only the controlled browser tab, not the full desktop.

Use:

`samples/highlevel-import-contacts-tutorial.json`

Workflow:

1. Import the tutorial JSON and click **Start**.
2. The agent prepares the target browser tab and pauses before the first tutorial action.
3. Click **Record Tutorial**.
4. The extension records the controlled tab through the existing Chrome debugger session while the agent moves the visible **Guide** pointer, shows action captions, and navigates the walkthrough.
5. Tutorial mode can attach an in-memory dummy CSV with `upload_sample_csv`; it never needs real customer data.
6. The agent stays read-only and should stop before a final submit/import/save action.
7. When the agent reaches `COMPLETE`, recording stops automatically and a `.webm` file is saved under `Downloads/ChatGPT Agents/`.

Tutorial recordings are currently video-only. Tab audio is not captured by the CDP screencast recorder.

Tutorial task JSON supports:

```json
{
  "task_mode": "tutorial",
  "tutorial": {
    "enabled": true,
    "title": "How to Import Contacts in HighLevel",
    "recordTabAudio": true,
    "pace": "guided"
  },
  "audit_mode": "tutorial read-only",
  "audit_target": {
    "url": "https://app.gohighlevel.com/"
  }
}
```

Tutorial video recording uses Chrome DevTools Protocol `Page.startScreencast` frames and an offscreen canvas/`MediaRecorder`. It does not require `activeTab` or `tabCapture` permission.



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
- `src/background/tutorial-recorder.js` — tab capture lifecycle and local download
- `src/offscreen/recorder.js` — MediaRecorder running in an offscreen document
- `src/tasks/prompt-builder.js` — agent/browser command contract
- `src/content/chatgpt-content.js` — ChatGPT prompt/image adapter
- `src/storage/repository.js` — durable state and v0.3 settings migration
- `samples/dynk-full-audit-autonomous.json` — recommended Dynk task
- `samples/highlevel-import-contacts-tutorial.json` — tutorial recording example

## Development

```bash
npm test
```

The extension has no build step.

## Limitations

The ChatGPT web adapter depends on the current ChatGPT DOM, so selectors can occasionally require maintenance after ChatGPT UI changes.

The `debugger` permission is powerful and visible to the browser. Enterprise browser policies may prevent debugger attachment or screenshot capture.

Automation stays inside the configured audit origin and does not bypass authentication, permissions, CAPTCHA, application authorization, or browser security controls.
