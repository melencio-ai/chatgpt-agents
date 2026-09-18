import { MESSAGE_TYPES, STORAGE_KEY, AGENT_STATES } from "../shared/constants.js";

const taskList = document.querySelector("#task-list");
const fileInput = document.querySelector("#file-input");
const notice = document.querySelector("#notice");
const summary = document.querySelector("#summary");
const defaultMode = document.querySelector("#default-mode");
const maxConcurrent = document.querySelector("#max-concurrent");
const maxContinuations = document.querySelector("#max-continuations");
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

function flash(message) {
  notice.hidden = false;
  notice.textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4500);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Extension request failed.");
  return response;
}

function agentForTask(taskId) {
  if (!state) return null;
  return Object.values(state.agents || {})
    .filter((agent) => agent.taskId === taskId)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

function friendlyStatus(agent, task) {
  if (!agent) return task.status || "Ready";
  return agent.state.replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (char) => char.toUpperCase());
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
  const hasLiveAgent = agent && ![AGENT_STATES.COMPLETE, AGENT_STATES.ERROR, AGENT_STATES.CANCELLED].includes(stateName);
  const canContinue = agent && [AGENT_STATES.RESPONSE_READY, AGENT_STATES.NEEDS_USER, AGENT_STATES.PAUSED, AGENT_STATES.READY].includes(stateName);
  const canPause = agent && ![AGENT_STATES.PAUSED, AGENT_STATES.COMPLETE, AGENT_STATES.CANCELLED, AGENT_STATES.ERROR].includes(stateName);

  return `
    <div class="actions">
      ${!hasLiveAgent ? `<button class="button primary" data-action="start" data-task-id="${esc(task.id)}">Start</button>` : ""}
      ${hasLiveAgent ? `<button class="button primary" data-action="restart" data-task-id="${esc(task.id)}">Restart</button>` : ""}
      ${canContinue ? `<button class="button" data-action="continue" data-task-id="${esc(task.id)}">Resume</button>` : ""}
      ${agent?.tabId ? `<button class="button" data-action="open" data-task-id="${esc(task.id)}">Open Chat</button>` : ""}
      ${canPause ? `<button class="button" data-action="pause" data-task-id="${esc(task.id)}">Pause</button>` : ""}
      ${agent && ![AGENT_STATES.COMPLETE, AGENT_STATES.CANCELLED].includes(stateName) ? `<button class="button danger" data-action="cancel" data-task-id="${esc(task.id)}">Cancel</button>` : ""}
    </div>`;
}

function renderTask(task) {
  const agent = agentForTask(task.id);
  const completed = (task.subtasks || []).filter((item) => item.completed).length;
  const total = (task.subtasks || []).length;
  const responsePreview = agent?.lastResponse ? agent.lastResponse.slice(-700) : "";
  const auditTarget = targetLabel(task);

  return `
    <article class="task-card">
      <div class="task-head">
        <div class="task-title">
          <strong>${esc(task.title)}</strong>
          <small>${esc(task.project || "No project")} · ${esc(task.priority || "P3 - Normal")}</small>
        </div>
        <span class="status">${esc(friendlyStatus(agent, task))}</span>
      </div>
      <div class="task-body">
        <div class="meta">
          <span>${total ? `${completed}/${total} subtasks` : "No subtasks"}</span>
          ${auditTarget ? `<span>browser: ${esc(auditTarget)}</span>` : ""}
          ${agent?.browserStepCount ? `<span>step ${agent.browserStepCount}</span>` : ""}
        </div>
        ${task.next_action ? `<p class="next-action"><strong>Goal:</strong> ${esc(task.next_action)}</p>` : ""}
        ${(task.subtasks || []).length ? `<ul class="subtasks">${task.subtasks.map((item) => `<li class="${item.completed ? "done" : ""}"><span>${item.completed ? "✓" : "○"}</span><span>${esc(item.title)}</span></li>`).join("")}</ul>` : ""}
        ${renderActions(task, agent)}
        ${agent?.lastBrowserObservation?.url ? `<div class="response">Browser: ${esc(agent.lastBrowserObservation.url)}</div>` : ""}
        ${agent?.error ? `<div class="error">${esc(agent.error)}</div>` : ""}
        ${responsePreview ? `<div class="response">${esc(responsePreview)}</div>` : ""}
      </div>
    </article>`;
}

function render() {
  if (!state) return;
  const tasks = Object.values(state.tasks || {}).sort((a, b) => String(b.updatedAt || b.importedAt || "").localeCompare(String(a.updatedAt || a.importedAt || "")));
  const activeCount = Object.values(state.agents || {}).filter((agent) => ![AGENT_STATES.COMPLETE, AGENT_STATES.ERROR, AGENT_STATES.CANCELLED, AGENT_STATES.PAUSED].includes(agent.state)).length;
  summary.textContent = `${tasks.length} task${tasks.length === 1 ? "" : "s"} · ${activeCount ? "agent working" : "idle"}`;

  defaultMode.value = "auto";
  maxConcurrent.value = 1;
  maxContinuations.value = state.settings?.maxAutoContinuations || 40;

  if (!tasks.length) {
    taskList.replaceChildren(emptyTemplate.content.cloneNode(true));
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
      case "pause":
        await send({ type: MESSAGE_TYPES.PAUSE_TASK, taskId });
        break;
      case "cancel":
        await send({ type: MESSAGE_TYPES.CANCEL_TASK, taskId });
        break;
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
        maxAutoContinuations: Math.max(5, Number(maxContinuations.value) || 40)
      }
    });
    state = response.state;
    render();
  } catch (error) {
    flash(error.message);
  }
}

maxContinuations.addEventListener("change", persistSettings);

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

refresh().catch((error) => flash(error.message));
