# ChatGPT Agents Tab Manager

A Manifest V3 Chrome/Edge extension for loading structured task JSON, assigning tasks to disposable ChatGPT browser tabs, monitoring multiple task conversations, and attaching read-only browser screenshots as audit evidence.

## V0.2 features

- Persistent side-panel control center.
- Imports either a single task object, an array of tasks, or `{ "project": ..., "tasks": [...] }`.
- Persists tasks, agents, runs, settings, ChatGPT URLs, errors, and last responses in `chrome.storage.local`.
- Manual, assisted, and auto execution modes.
- Configurable parallel-agent limit and auto-continuation limit.
- Creates/binds ChatGPT worker tabs independently from task records.
- Injects initial and continuation prompts through a dedicated ChatGPT content adapter.
- Watches generation and reports response completion back to the service worker.
- Uses `AGENT_STATUS` / `NEXT_ACTION` response markers for deterministic continuation decisions.
- Pause, resume, cancel, continue, open-tab, pause-all, and resume-all controls.
- Queueing when the configured concurrency limit is reached.
- Basic recovery when a worker tab is closed.
- Read-only audit task fields: `audit_mode`, `audit_target`, `audit_focus`, `deliverables`, and `instructions`.
- **Capture evidence** action for audit tasks.
- Full-page screenshot capture through Chrome DevTools Protocol via `chrome.debugger`.
- Screenshot attachment into the matching ChatGPT task conversation.
- Evidence count and last captured URL shown in the side panel.

## Install locally

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this repository folder.
5. Click the extension toolbar action to open the side panel.
6. Keep yourself signed in to `https://chatgpt.com/`.
7. Import `samples/task.json` or your own task JSON.

No build step or external dependency is required.

## Updating an unpacked install

If you originally downloaded the repository as a ZIP:

1. Download the latest ZIP.
2. Replace the files in your existing unpacked extension folder.
3. Open `edge://extensions` or `chrome://extensions`.
4. Find **ChatGPT Agents Tab Manager**.
5. Click **Reload**.

Version 0.2 adds the powerful `debugger` permission. The browser may show a new permission warning when the extension is reloaded or re-enabled.

## Audit screenshot workflow

Audit task JSON can include:

```json
{
  "audit_mode": "read_only",
  "audit_target": {
    "url": "https://app.example.com/"
  },
  "audit_focus": ["Booking flow", "Mobile UX"],
  "instructions": ["Do not save changes"]
}
```

Workflow:

1. Start the audit task so its ChatGPT worker tab exists.
2. Open or navigate the audit target in another browser tab.
3. Put that target tab on the exact page/state you want reviewed.
4. In the extension side panel, click **Capture evidence** for the matching task.
5. The extension captures the target tab with the debugger protocol and attaches the image to that task's ChatGPT composer.
6. Click **Continue** when the agent is ready for that evidence.
7. Repeat for additional pages/states requested by the agent.

The extension prefers the currently active tab whose origin matches `audit_target.url`. Screenshots are passed directly to the matching ChatGPT tab and are not stored as image blobs in extension storage.

If browser DevTools or another debugger client is already attached to the target tab, close it before using **Capture evidence**.

## Dynk three-agent audit

Import:

`samples/dynk-full-audit-3-agents.json`

Recommended settings:

- Mode: **Assisted**
- Parallel: **3**
- Keep the Dynk audit read-only.
- Start all three tasks.
- Supply each agent with the screens it asks for using **Capture evidence**.
- Do not submit forms or perform destructive actions during the audit.

## Execution modes

- **Manual**: creates/binds the ChatGPT tab but does not submit a prompt.
- **Assisted**: submits the first prompt automatically; further continuation requires the **Continue** button.
- **Auto**: submits the first prompt and follows `AGENT_STATUS: CONTINUE` automatically up to the configured loop limit.

Generated prompts ask ChatGPT to finish responses with:

```text
AGENT_STATUS: CONTINUE | COMPLETE | BLOCKED
NEXT_ACTION: <short next action or blocker>
```

For audit tasks, agents are additionally instructed to remain read-only, avoid unsupported claims, and use `BLOCKED` when another page or state is required.

## Architecture

```text
Side Panel
   |
   v
MV3 Service Worker ---- chrome.storage.local
   |
   +---- Task Runner / Queue / State Machine
   |
   +---- Evidence Capture ---- chrome.debugger / CDP
   |                              |
   |                              v
   |                         Audit target tab
   |
   +---- chrome.tabs
             |
             v
      ChatGPT worker tabs
             |
             v
      Content adapter
      - composer detection
      - prompt injection
      - screenshot attachment
      - generation detection
      - latest response extraction
```

Tasks are durable records. Browser tabs are disposable workers. Closing a tab therefore does not delete or corrupt its task.

## State model

Agent states include:

`QUEUED`, `CREATING_TAB`, `WAITING_FOR_CHATGPT`, `READY`, `INJECTING_PROMPT`, `SUBMITTED`, `GENERATING`, `RESPONSE_READY`, `EVALUATING`, `PAUSED`, `NEEDS_USER`, `COMPLETE`, `ERROR`, `CANCELLED`.

## Development

The extension is intentionally dependency-free. Pure task parsing and prompt logic have Node tests:

```bash
npm test
```

## Important limitations

The ChatGPT content adapter necessarily depends on ChatGPT's web UI. Selectors are isolated in `src/content/chatgpt-content.js` so UI changes can be repaired in one place.

The screenshot evidence feature uses the browser debugger API and DevTools Protocol. It is deliberately scoped by task configuration and only captures a matching audit-target origin. Browser enterprise policies can block debugger attachment or screenshot capture.

The automation uses the normal signed-in browser UI; it does not bypass authentication, account controls, application permissions, or platform limits.
