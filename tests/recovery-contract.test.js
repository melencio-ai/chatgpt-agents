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

test("prompt injection survives ChatGPT composer rerenders and rich-text insertion changes", async () => {
  const source = await readFile(new URL("../src/content/chatgpt-content.js", import.meta.url), "utf8");
  assert.match(source, /populateComposerPrompt/);
  assert.match(source, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/);
  assert.match(source, /ClipboardEvent\("paste"/);
  assert.match(source, /replaceEditableDom/);
  assert.match(source, /requestSubmit/);
  assert.match(source, /lastMethod=/);
  assert.match(source, /describeComposerEnvironment/);
});

test("prompt injection falls back to Chrome debugger input when DOM injection fails", async () => {
  const runner = await readFile(new URL("../src/background/task-runner.js", import.meta.url), "utf8");
  const browser = await readFile(new URL("../src/background/browser-operator.js", import.meta.url), "utf8");
  assert.match(runner, /injectChatPromptViaDebugger/);
  assert.match(runner, /Prompt injection failed by both methods/);
  assert.match(browser, /export async function injectChatPromptViaDebugger/);
  assert.match(browser, /Input\.insertText/);
  assert.match(browser, /Input\.dispatchKeyEvent/);
  assert.match(browser, /Debugger prompt injection could not find ChatGPT composer/);
  assert.match(browser, /Debugger prompt injection populated ChatGPT but submission did not start/);
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

test("conversation length exhaustion rolls the same agent into a fresh ChatGPT chat", async () => {
  const content = await readFile(new URL("../src/content/chatgpt-content.js", import.meta.url), "utf8");
  const runner = await readFile(new URL("../src/background/task-runner.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/background/service-worker.js", import.meta.url), "utf8");

  assert.match(content, /conversationMaxLengthPattern/);
  assert.match(content, /conversation_max_length/);
  assert.match(content, /errorCode:\s*details\.code/);
  assert.match(content, /bottomNotices/);
  assert.match(content, /data-message-author-role='user'/);
  assert.match(content, /data-message-author-role='assistant'/);

  assert.match(runner, /CONVERSATION_MAX_LENGTH_PATTERN/);
  assert.match(runner, /rolloverConversation/);
  assert.match(runner, /url:\s*"https:\/\/chatgpt\.com\/"/);
  assert.match(runner, /conversationHistory/);
  assert.match(runner, /pendingRollover/);
  assert.match(runner, /buildRolloverPrompt/);
  assert.match(runner, /previousResult:\s*responseTail\(current\.lastResponse\)/);
  assert.match(runner, /errorCode === "conversation_max_length"/);

  assert.match(worker, /message\.errorCode \|\| ""/);
});
