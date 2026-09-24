import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("task card detail state is computed in the task renderer", async () => {
  const source = await readFile(new URL("../src/sidepanel/app.js", import.meta.url), "utf8");
  const actionsStart = source.indexOf("function renderActions");
  const taskStart = source.indexOf("function renderTask", actionsStart);
  const noticeStart = source.indexOf("function renderDetectedTaskNotice", taskStart);

  assert.ok(actionsStart >= 0 && taskStart > actionsStart && noticeStart > taskStart);

  const renderActions = source.slice(actionsStart, taskStart);
  const renderTask = source.slice(taskStart, noticeStart);

  assert.doesNotMatch(renderActions, /responsePreview|const expanded|const hasDetails/);
  assert.match(renderTask, /const responsePreview/);
  assert.match(renderTask, /const expanded = expandedTaskIds\.has\(task\.id\)/);
  assert.match(renderTask, /const hasDetails = Boolean\(/);
  assert.match(renderTask, /\$\{total - completed\} remaining/);
  assert.match(renderTask, /item\.completed \? "done" : ""/);
});

test("side panel exposes an opt-in one-to-three concurrent agent setting", async () => {
  const html = await readFile(new URL("../src/sidepanel/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/sidepanel/app.js", import.meta.url), "utf8");

  assert.match(html, /id="max-concurrent"[^>]*min="1"[^>]*max="3"[^>]*value="1"/);
  assert.doesNotMatch(html, /id="max-concurrent"[^>]*disabled/);
  assert.match(source, /maxConcurrent\.addEventListener\("change", persistSettings\)/);
  assert.match(source, /normalizeMaxConcurrentAgents\(maxConcurrent\.value\)/);
});
