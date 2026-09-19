import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("content script recovers machine-readable responses without submission memory", async () => {
  const source = await readFile(new URL("../src/content/chatgpt-content.js", import.meta.url), "utf8");
  assert.match(source, /hasAgentDirective/);
  assert.match(source, /allowUnsubmitted:\s*true/);
  assert.match(source, /reportLatestAssistant/);
  assert.match(source, /setInterval\(\(\) =>/);
});

test("task runner reconciles reloaded active chats and deduplicates responses", async () => {
  const source = await readFile(new URL("../src/background/task-runner.js", import.meta.url), "utf8");
  assert.match(source, /RECOVERABLE_CHAT_STATES/);
  assert.match(source, /GET_CHAT_STATE/);
  assert.match(source, /reconcileAgentChatState/);
  assert.match(source, /responseTail\(latest\) === responseTail\(agent\.lastResponse\)/);
  assert.match(source, /next_action:\s*directive\.nextAction/);
});
