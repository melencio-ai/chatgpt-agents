# ChatGPT Agents Tab Manager

A Manifest V3 Chrome/Edge extension for loading structured task JSON, assigning tasks to disposable ChatGPT browser tabs, and monitoring multiple task conversations from a persistent side panel.

## V0.1 features

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

## Install locally

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this repository folder.
5. Click the extension toolbar action to open the side panel.
6. Keep yourself signed in to `https://chatgpt.com/`.
7. Import `samples/task.json` or your own task JSON.

No build step or external dependency is required.

## JSON formats

The importer supports the original single-task shape:

```json
{
  "title": "Build browser extension to automate multiple ChatGPT tabs",
  "project": "ChatGPT Tab Manager Extension",
  "owner": "Melencio",
  "priority": "P3 - Normal",
  "status": "Now",
  "next_action": "Implement JSON file loading",
  "subtasks": [
    { "title": "Design architecture", "completed": true },
    { "title": "Implement JSON loading", "completed": false }
  ]
}
```

It also accepts an array of task objects or a project wrapper.

## Execution modes

- **Manual**: creates/binds the ChatGPT tab but does not submit a prompt.
- **Assisted**: submits the first prompt automatically; further continuation requires the **Continue** button.
- **Auto**: submits the first prompt and follows `AGENT_STATUS: CONTINUE` automatically up to the configured loop limit.

Generated prompts ask ChatGPT to finish responses with:

```text
AGENT_STATUS: CONTINUE | COMPLETE | BLOCKED
NEXT_ACTION: <short next action or blocker>
```

If Auto mode receives no valid marker, it stops at **Needs User** instead of guessing.

## Architecture

```text
Side Panel
   |
   v
MV3 Service Worker ---- chrome.storage.local
   |
   +---- Task Runner / Queue / State Machine
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

## Important limitation

The ChatGPT content adapter necessarily depends on ChatGPT's web UI. Selectors are isolated in `src/content/chatgpt-content.js` so UI changes can be repaired in one place. The automation uses the normal signed-in browser UI; it does not bypass authentication, account controls, or platform limits.
