import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("content script recovers machine-readable responses without submission memory", async () => {
  const source = await readFile(new URL("../src/content/chatgpt-content.js", import.meta.url), "utf8");
  assert.match(source, /hasAgentDirective/);
  assert.match(source, /allowUnsubmitted:\s*true/);
  assert.match(source, /reportLatestAssistant/);
  assert.match(source, /setInterval\(\(\) =>/);
  assert.match(source, /CHATGPT_ERROR/);
  assert.match(source, /getChatErrorText/);
  assert.match(source, /something went wrong/);
});

test("task runner reconciles reloaded active chats and deduplicates responses", async () => {
  const source = await readFile(new URL("../src/background/task-runner.js", import.meta.url), "utf8");
  assert.match(source, /RECOVERABLE_CHAT_STATES/);
  assert.match(source, /GET_CHAT_STATE/);
  assert.match(source, /reconcileAgentChatState/);
  assert.match(source, /responseTail\(latest\) === responseTail\(agent\.lastResponse\)/);
  assert.match(source, /next_action:\s*directive\.nextAction/);
  assert.match(source, /recordCompletedSubtasks\(agent\.taskId, directive\.completedSubtaskIds\)/);
  assert.match(source, /subtasks:\s*\(task\.subtasks \|\| \[\]\)\.map/);
});


test("service worker rehydrates ChatGPT tabs after extension reload", async () => {
  const source = await readFile(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
  assert.match(source, /rehydrateChatTabs/);
  assert.match(source, /ensureChatContentScript/);
  assert.match(source, /chrome\.scripting\.executeScript/);
  assert.match(source, /https:\/\/chatgpt\.com\/\*/);
});

test("prompt injection retries by reinjecting the content script when missing", async () => {
  const source = await readFile(new URL("../src/background/task-runner.js", import.meta.url), "utf8");
  assert.match(source, /sendChatMessage/);
  assert.match(source, /files:\s*\["src\/content\/chatgpt-content\.js"\]/);
  assert.match(source, /type:\s*MESSAGE_TYPES\.INJECT_PROMPT/);
});

test("interactive browser tasks support visible-field typing and bounded key input", async () => {
  const source = await readFile(new URL("../src/background/browser-operator.js", import.meta.url), "utf8");
  assert.match(source, /action\.type === "type_text"/);
  assert.match(source, /Input\.insertText/);
  assert.match(source, /action\.type === "press_key"/);
  assert.match(source, /Input\.dispatchKeyEvent/);
  assert.match(source, /allowStateChanges/);
});

test("task runner applies the normalized configured queue limit", async () => {
  const source = await readFile(new URL("../src/background/task-runner.js", import.meta.url), "utf8");
  assert.match(source, /normalizeMaxConcurrentAgents\(state\.settings\.maxConcurrentAgents\)/);
  assert.match(source, /export async function enforceAgentLimit/);
  assert.match(source, /active\.slice\(limit\)/);
  assert.match(source, /paused\.slice\(0, Math\.max\(0, limit - activeCount\)\)/);
  assert.match(source, /ensureAgentAuditTab/);
  assert.match(source, /reuseExisting:\s*Boolean\(agent\.auditTabId\)/);
});

test("service worker enforces the configured agent limit whenever it loads", async () => {
  const source = await readFile(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
  assert.match(source, /const startupSafety = initializeState\(\)/);
  assert.match(source, /\.then\(\(\) => enforceAgentLimit\(\)\)/);
  assert.match(source, /await startupSafety;\s*await chrome\.sidePanel/);
  assert.match(source, /await startupSafety;\s*await rehydrateChatTabs/);
});

test("service worker does not schedule an automatic recovery watchdog", async () => {
  const source = await readFile(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../manifest.json", import.meta.url), "utf8");
  assert.doesNotMatch(manifest, /"alarms"/);
  assert.doesNotMatch(source, /chrome\.alarms/);
  assert.doesNotMatch(source, /runAgentWatchdog/);
});

test("watchdog injects a bounded contextual Continue prompt", async () => {
  const source = await readFile(new URL("../src/background/task-runner.js", import.meta.url), "utf8");
  assert.match(source, /export async function runAgentWatchdog/);
  assert.match(source, /Continue the current task from where you stopped/);
  assert.match(source, /MAX_AGENT_WAKE_ATTEMPTS/);
  assert.match(source, /MESSAGE_TYPES\.STOP_GENERATION/);
  assert.match(source, /buildWakeUpPrompt/);
});

test("visible ChatGPT failures are surfaced without an automatic wake-up", async () => {
  const source = await readFile(new URL("../src/background/service-worker.js", import.meta.url), "utf8");
  assert.match(source, /case MESSAGE_TYPES\.CHATGPT_ERROR/);
  assert.match(source, /handleChatError/);
  assert.doesNotMatch(source, /runWatchdogOnce/);
});
