import { MESSAGE_TYPES, STORAGE_KEY, AGENT_STATES } from "../shared/constants.js";

const taskList = document.querySelector("#task-list");
const fileInput = document.querySelector("#file-input");
const notice = document.querySelector("#notice");
const summary = document.querySelector("#summary");
const defaultMode = document.querySelector("#default-mode");
const maxConcurrent = document.querySelector("#max-concurrent");
const maxContinuations = document.querySelector("#max-continuations");
const visualMouse = document.querySelector("#visual-mouse");
const hideCompletedTasks = document.querySelector("#hide-completed");
const autoDetectTaskJson = document.querySelector("#auto-detect-task-json");
const autoImportTaskJson = document.querySelector("#auto-import-task-json");
const autoStartTaskJson = document.querySelector("#auto-start-task-json");
const detectedTaskNotice = document.querySelector("#detected-task-notice");
const emptyTemplate = document.querySelector("#empty-template");

let state = null;
let noticeTimer = null;

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function flash(message, persistent = false) {
  notice.hidden = false;
  notice.textContent = message;
  clearTimeout(noticeTimer);
  if (!persistent) {
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 4500);
  }
}

function isDisconnectedRuntimeError(error) {
  const message = String(error?.message || error || "");
  return /receiving end does not exist|could not establish connection|extension context invalidated|message port closed/i.test(message);
}

async function send(message) {
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isDisconnectedRuntimeError(error)) {
      throw new Error("The extension was reloaded and this side panel is stale. Close and reopen ChatGPT Agents, then retry.");
    }
    throw error;
  }

  if (!response?.ok) {
    const error = new Error(response?.error || "Extension request failed.");
    if (isDisconnectedRuntimeError(error)) {
      throw new Error("The ChatGPT receiver was unavailable. The extension will reattach it automatically; retry this action once.");
    }
    throw error;
  }
  return response;
}

function agentForTask(taskId) {
  if (!state) return null;
  return Object.values(state.agents || {})
    .filter((agent) => agent.taskId === taskId)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

function runForAgent(agent) {
  if (!state || !agent?.runId) return null;
  return state.runs?.[agent.runId] || null;
}

function isTerminalState(value) {
  return [
    AGENT_STATES.COMPLETE,
    AGENT_STATES.ERROR,
    AGENT_STATES.CANCELLED
  ].includes(value);
}

function formatRuntime(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function runtimeForAgent(agent) {
  if (!agent) return null;

  const run = runForAgent(agent);
  const startedAt = run?.startedAt || agent.createdAt;
  if (!startedAt) return null;

  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;

  let endMs = Date.now();
  if (run?.completedAt) {
    endMs = Date.parse(run.completedAt);
  } else if (isTerminalState(agent.state) && agent.updatedAt) {
    endMs = Date.parse(agent.updatedAt);
  }

  if (!Number.isFinite(endMs)) endMs = Date.now();

  return {
    elapsed: formatRuntime(endMs - startMs),
    live: !isTerminalState(agent.state) && agent.state !== AGENT_STATES.PAUSED,
    paused: agent.state === AGENT_STATES.PAUSED
  };
}

function friendlyStatus(agent, task) {
  if (!agent) return task.status || "Ready";
  return agent.state.replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (char) => char.toUpperCase());
}

function isTaskCompleted(task) {
  const agent = agentForTask(task.id);
  if (agent?.state === AGENT_STATES.COMPLETE) return true;
  const status = String(task.status || "").trim().toLowerCase();
  return ["complete", "completed", "done"].includes(status);
}

function targetLabel(task) {
  try {
    return task.audit_target?.url ? new URL(task.audit_target.url).hostname : "";
  } catch {
    return "";
  }
}

function renderActions(task, agent) {
  const stateName = agent?.state;
  const tutorial = Boolean(task.tutorial?.enabled);
  const hasLiveAgent = agent && ![AGENT_STATES.COMPLETE, AGENT_STATES.ERROR, AGENT_STATES.CANCELLED].includes(stateName);
  const canContinue = agent && [AGENT_STATES.RESPONSE_READY, AGENT_STATES.NEEDS_USER, AGENT_STATES.PAUSED, AGENT_STATES.READY].includes(stateName);
  const canPause = agent && ![AGENT_STATES.PAUSED, AGENT_STATES.COMPLETE, AGENT_STATES.CANCELLED, AGENT_STATES.ERROR].includes(stateName);
  const buttons = [];

  if (!hasLiveAgent) buttons.push('<button class="button primary" data-action="start" data-task-id="' + esc(task.id) + '">Start</button>');
  if (hasLiveAgent) buttons.push('<button class="button primary" data-action="restart" data-task-id="' + esc(task.id) + '">Restart</button>');
  if (canContinue) buttons.push('<button class="button" data-action="continue" data-task-id="' + esc(task.id) + '">Resume</button>');
  if (agent?.tabId) buttons.push('<button class="button" data-action="open" data-task-id="' + esc(task.id) + '">Open Chat</button>');
  if (tutorial && agent?.auditTabId) buttons.push('<button class="button" data-action="open-browser" data-task-id="' + esc(task.id) + '">Open Browser</button>');
  if (canPause) buttons.push('<button class="button" data-action="pause" data-task-id="' + esc(task.id) + '">Pause</button>');
  if (agent && ![AGENT_STATES.COMPLETE, AGENT_STATES.CANCELLED].includes(stateName)) buttons.push('<button class="button danger" data-action="cancel" data-task-id="' + esc(task.id) + '">Cancel</button>');

  return '<div class="actions">' + buttons.join("") + '</div>';
}

function renderTask(task) {
  const agent = agentForTask(task.id);
  const completed = (task.subtasks || []).filter((item) => item.completed).length;
  const total = (task.subtasks || []).length;
  const responsePreview = agent?.lastResponse ? agent.lastResponse.slice(-700) : "";
  const auditTarget = targetLabel(task);
  const runtime = runtimeForAgent(agent);
  const tutorial = Boolean(task.tutorial?.enabled);

  return `
    <article class="task-card">
      <div class="task-head">
        <div class="task-title">
          <strong>${esc(task.title)}</strong>
          <small>${esc(task.project || "No project")} · ${esc(task.priority || "P3 - Normal")}</small>
        </div>
        <span class="status">${esc(friendlyStatus(agent, task))}</span>
        <button
          class="icon-button danger"
          data-action="delete"
          data-task-id="${esc(task.id)}"
          title="Delete task"
          aria-label="Delete task"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 11H8L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z"></path>
          </svg>
        </button>
      </div>
      <div class="task-body">
        <div class="meta">
          <span>${total ? `${completed}/${total} subtasks` : "No subtasks"}</span>
          ${runtime ? `<span class="runtime ${runtime.live ? "live" : runtime.paused ? "paused" : "finished"}"><i></i>${runtime.live ? "LIVE" : runtime.paused ? "PAUSED" : "RUNTIME"} · ${runtime.elapsed}</span>` : ""}
          ${tutorial ? `<span class="tutorial-badge">TUTORIAL</span>` : ""}
          ${auditTarget ? `<span>browser: ${esc(auditTarget)}</span>` : ""}
          ${agent?.browserStepCount ? `<span>step ${agent.browserStepCount}</span>` : ""}
        </div>
        ${task.next_action ? `<p class="next-action"><strong>Goal:</strong> ${esc(task.next_action)}</p>` : ""}
        ${(task.subtasks || []).length ? `<ul class="subtasks">${task.subtasks.map((item) => `<li class="${item.completed ? "done" : ""}"><span class="subtask-state" aria-hidden="true">${item.completed ? "✓" : "○"}</span><span class="subtask-title">${esc(item.title)}</span></li>`).join("")}</ul>` : ""}
        ${renderActions(task, agent)}
        ${agent?.lastBrowserObservation?.url ? `<div class="response">Browser: ${esc(agent.lastBrowserObservation.url)}</div>` : ""}
        ${agent?.error ? `<div class="error">${esc(agent.error)}</div>` : ""}
        ${responsePreview ? `<div class="response">${esc(responsePreview)}</div>` : ""}
      </div>
    </article>`;
}

function renderDetectedTaskNotice() {
  const detection = state?.lastTaskDetection;
  if (!detection) {
    detectedTaskNotice.hidden = true;
    detectedTaskNotice.textContent = "";
    return;
  }

  const taskWord = detection.taskCount === 1 ? "task" : "tasks";
  if (detection.importedCount > 0) {
    detectedTaskNotice.textContent = `Auto-imported ${detection.importedCount} detected ${taskWord} from ChatGPT.`;
  } else if (detection.skippedExisting > 0) {
    detectedTaskNotice.textContent = `Detected ${detection.taskCount} ${taskWord}; existing task IDs were kept unchanged.`;
  } else {
    detectedTaskNotice.textContent = `Detected ${detection.taskCount} ${taskWord} in ChatGPT. Auto import is off.`;
  }
  detectedTaskNotice.hidden = false;
}

function renderTaskJsonSettings() {
  autoDetectTaskJson.checked = state.settings?.autoDetectTaskJson !== false;
  autoImportTaskJson.checked = state.settings?.autoImportDetectedTasks !== false;
  autoStartTaskJson.checked = state.settings?.autoStartDetectedTasks === true;

  autoImportTaskJson.disabled = !autoDetectTaskJson.checked;
  autoStartTaskJson.disabled = !autoDetectTaskJson.checked || !autoImportTaskJson.checked;
}

function render() {
  if (!state) return;
  const allTasks = Object.values(state.tasks || {}).sort((a, b) => String(b.updatedAt || b.importedAt || "").localeCompare(String(a.updatedAt || a.importedAt || "")));
  const hideCompleted = state.settings?.hideCompletedTasks === true;
  const tasks = hideCompleted ? allTasks.filter((task) => !isTaskCompleted(task)) : allTasks;
  const activeCount = Object.values(state.agents || {}).filter((agent) => ![AGENT_STATES.COMPLETE, AGENT_STATES.ERROR, AGENT_STATES.CANCELLED, AGENT_STATES.PAUSED].includes(agent.state)).length;
  const taskCountLabel = hideCompleted && tasks.length !== allTasks.length
    ? `${tasks.length}/${allTasks.length} tasks`
    : `${allTasks.length} task${allTasks.length === 1 ? "" : "s"}`;
  summary.textContent = `${taskCountLabel} · ${activeCount ? "agent working" : "idle"}`;

  defaultMode.value = "auto";
  maxConcurrent.value = 1;
  maxContinuations.value = state.settings?.maxAutoContinuations || 40;
  visualMouse.checked = state.settings?.visualMouse !== false;
  hideCompletedTasks.checked = hideCompleted;
  renderTaskJsonSettings();
  renderDetectedTaskNotice();

  if (!allTasks.length) {
    taskList.replaceChildren(emptyTemplate.content.cloneNode(true));
    return;
  }
  if (!tasks.length) {
    taskList.innerHTML = '<section class="empty-state"><strong>All completed tasks are hidden</strong><p>Uncheck “Hide completed” to show them again.</p></section>';
    return;
  }
  taskList.innerHTML = tasks.map(renderTask).join("");
}

async function refresh() {
  const response = await send({ type: MESSAGE_TYPES.GET_STATE });
  state = response.state;
  render();
}

fileInput.addEventListener("change", async () => {
  const [file] = fileInput.files;
  if (!file) return;
  try {
    const payload = await file.text();
    const response = await send({ type: MESSAGE_TYPES.IMPORT_TASK_PAYLOAD, payload });
    state = response.state;
    render();
    flash(`Imported ${response.imported} task${response.imported === 1 ? "" : "s"}.`);
  } catch (error) {
    flash(`Import failed: ${error.message}`);
  } finally {
    fileInput.value = "";
  }
});

taskList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const taskId = button.dataset.taskId;
  button.disabled = true;
  try {
    switch (button.dataset.action) {
      case "start":
        await send({ type: MESSAGE_TYPES.START_TASK, taskId, mode: "auto", forceRestart: false });
        break;
      case "restart":
        await send({ type: MESSAGE_TYPES.START_TASK, taskId, mode: "auto", forceRestart: true });
        flash("Fresh agent started.");
        break;
      case "continue":
        await send({ type: MESSAGE_TYPES.CONTINUE_TASK, taskId });
        break;
      case "open":
        await send({ type: MESSAGE_TYPES.OPEN_TASK_TAB, taskId });
        break;
      case "open-browser":
        await send({ type: MESSAGE_TYPES.OPEN_BROWSER_TAB, taskId });
        break;
      case "pause":
        await send({ type: MESSAGE_TYPES.PAUSE_TASK, taskId });
        break;
      case "cancel":
        await send({ type: MESSAGE_TYPES.CANCEL_TASK, taskId });
        break;
      case "delete": {
        const task = state?.tasks?.[taskId];
        const label = task?.title || "this task";
        if (!confirm(`Delete "${label}" and its saved run history?`)) break;
        await send({ type: MESSAGE_TYPES.DELETE_TASK, taskId });
        flash("Task deleted.");
        break;
      }
    }
    await refresh();
  } catch (error) {
    flash(error.message);
  } finally {
    button.disabled = false;
  }
});

async function persistSettings() {
  try {
    const response = await send({
      type: MESSAGE_TYPES.UPDATE_SETTINGS,
      patch: {
        defaultMode: "auto",
        maxConcurrentAgents: 1,
        maxAutoContinuations: Math.max(5, Number(maxContinuations.value) || 40),
        visualMouse: visualMouse.checked,
        hideCompletedTasks: hideCompletedTasks.checked,
        autoDetectTaskJson: autoDetectTaskJson.checked,
        autoImportDetectedTasks: autoImportTaskJson.checked,
        autoStartDetectedTasks: autoDetectTaskJson.checked && autoImportTaskJson.checked && autoStartTaskJson.checked
      }
    });
    state = response.state;
    render();
  } catch (error) {
    flash(error.message);
  }
}

maxContinuations.addEventListener("change", persistSettings);
visualMouse.addEventListener("change", persistSettings);
hideCompletedTasks.addEventListener("change", persistSettings);
autoDetectTaskJson.addEventListener("change", persistSettings);
autoImportTaskJson.addEventListener("change", persistSettings);
autoStartTaskJson.addEventListener("change", persistSettings);

document.querySelector("#pause-all").addEventListener("click", async () => {
  await send({ type: MESSAGE_TYPES.PAUSE_ALL });
  await refresh();
});

document.querySelector("#resume-all").addEventListener("click", async () => {
  await send({ type: MESSAGE_TYPES.RESUME_ALL });
  await refresh();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]?.newValue) return;
  state = changes[STORAGE_KEY].newValue;
  render();
});

refresh().catch((error) => flash(`Extension runtime failed: ${error.message}`, true));

setInterval(() => {
  if (!state) return;
  const hasRunningAgent = Object.values(state.agents || {}).some((agent) =>
    !isTerminalState(agent.state) && agent.state !== AGENT_STATES.PAUSED
  );
  if (hasRunningAgent) render();
}, 1000);
