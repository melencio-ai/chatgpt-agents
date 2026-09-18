import {
  AGENT_STATES,
  EXECUTION_MODES,
  TERMINAL_AGENT_STATES,
  MESSAGE_TYPES
} from "../shared/constants.js";
import {
  getState,
  updateState,
  getTask,
  getAgentByTaskId,
  getAgentByTabId
} from "../storage/repository.js";
import {
  buildInitialPrompt,
  buildContinuationPrompt,
  parseAgentDirective
} from "../tasks/prompt-builder.js";

const ACTIVE_STATES = new Set([
  AGENT_STATES.CREATING_TAB,
  AGENT_STATES.WAITING_FOR_CHATGPT,
  AGENT_STATES.READY,
  AGENT_STATES.INJECTING_PROMPT,
  AGENT_STATES.SUBMITTED,
  AGENT_STATES.GENERATING,
  AGENT_STATES.RESPONSE_READY,
  AGENT_STATES.EVALUATING,
  AGENT_STATES.NEEDS_USER
]);

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function patchAgent(agentId, patch) {
  return updateState((state) => {
    const existing = state.agents[agentId];
    if (!existing) return;
    state.agents[agentId] = { ...existing, ...patch, updatedAt: nowIso() };
  });
}

async function patchTask(taskId, patch) {
  return updateState((state) => {
    const existing = state.tasks[taskId];
    if (!existing) return;
    state.tasks[taskId] = { ...existing, ...patch, updatedAt: nowIso() };
  });
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function createRun(taskId, mode) {
  const agentId = makeId("agent");
  const runId = makeId("run");
  const timestamp = nowIso();

  await updateState((state) => {
    state.agents[agentId] = {
      id: agentId,
      taskId,
      runId,
      tabId: null,
      conversationUrl: "",
      mode,
      state: AGENT_STATES.QUEUED,
      continuationCount: 0,
      lastResponse: "",
      lastDirective: null,
      error: "",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.runs[runId] = {
      id: runId,
      taskId,
      agentId,
      mode,
      startedAt: timestamp,
      completedAt: null,
      status: AGENT_STATES.QUEUED
    };
  });

  return agentId;
}

async function launchAgent(agentId) {
  const state = await getState();
  const agent = state.agents[agentId];
  const task = agent ? state.tasks[agent.taskId] : null;
  if (!agent || !task) throw new Error("Task or agent no longer exists.");

  await patchAgent(agentId, { state: AGENT_STATES.CREATING_TAB, error: "" });
  const targetUrl = task.chatgpt_url && task.chatgpt_url.startsWith("https://chatgpt.com/")
    ? task.chatgpt_url
    : "https://chatgpt.com/";

  const tab = await chrome.tabs.create({ url: targetUrl, active: false });
  await patchAgent(agentId, {
    tabId: tab.id,
    conversationUrl: tab.url || targetUrl,
    state: AGENT_STATES.WAITING_FOR_CHATGPT
  });
}

export async function pumpQueue() {
  const state = await getState();
  const limit = Math.max(1, Number(state.settings.maxConcurrentAgents) || 1);
  let available = limit - Object.values(state.agents).filter((agent) => ACTIVE_STATES.has(agent.state)).length;
  if (available <= 0) return;

  const queued = Object.values(state.agents)
    .filter((agent) => agent.state === AGENT_STATES.QUEUED)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  for (const agent of queued) {
    if (available <= 0) break;
    await launchAgent(agent.id);
    available -= 1;
  }
}

export async function startTask(taskId, requestedMode) {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found.");

  const previous = await getAgentByTaskId(taskId);
  if (previous && !TERMINAL_AGENT_STATES.has(previous.state) && previous.state !== AGENT_STATES.PAUSED) {
    if (await tabExists(previous.tabId)) return previous;
  }

  const state = await getState();
  const mode = Object.values(EXECUTION_MODES).includes(requestedMode)
    ? requestedMode
    : state.settings.defaultMode;
  const agentId = await createRun(taskId, mode);
  await pumpQueue();
  const latest = await getState();
  return latest.agents[agentId];
}

async function injectPrompt(agent, prompt) {
  if (!agent.tabId || !(await tabExists(agent.tabId))) {
    await patchAgent(agent.id, { state: AGENT_STATES.ERROR, error: "ChatGPT tab is no longer available." });
    await pumpQueue();
    return;
  }

  await patchAgent(agent.id, { state: AGENT_STATES.INJECTING_PROMPT, error: "" });
  try {
    const response = await chrome.tabs.sendMessage(agent.tabId, {
      type: MESSAGE_TYPES.INJECT_PROMPT,
      prompt
    });
    if (!response?.ok) throw new Error(response?.error || "Prompt injection failed.");
    await patchAgent(agent.id, { state: AGENT_STATES.SUBMITTED });
  } catch (error) {
    await patchAgent(agent.id, { state: AGENT_STATES.ERROR, error: String(error?.message || error) });
    await pumpQueue();
  }
}

export async function handlePageReady(tabId, pageUrl) {
  const agent = await getAgentByTabId(tabId);
  if (!agent || TERMINAL_AGENT_STATES.has(agent.state) || agent.state === AGENT_STATES.CANCELLED) return;

  const conversationUrl = pageUrl || agent.conversationUrl;
  await patchAgent(agent.id, { conversationUrl });
  await patchTask(agent.taskId, { chatgpt_url: conversationUrl });

  // ChatGPT changes the URL after a new conversation is created. That route
  // change must update the binding without re-sending the initial prompt.
  if (![AGENT_STATES.CREATING_TAB, AGENT_STATES.WAITING_FOR_CHATGPT].includes(agent.state)) return;

  await patchAgent(agent.id, { state: AGENT_STATES.READY });
  if (agent.mode === EXECUTION_MODES.MANUAL) return;

  const task = await getTask(agent.taskId);
  await injectPrompt({ ...agent, tabId, conversationUrl }, buildInitialPrompt(task));
}

export async function markGenerating(tabId) {
  const agent = await getAgentByTabId(tabId);
  if (!agent || agent.state === AGENT_STATES.PAUSED || TERMINAL_AGENT_STATES.has(agent.state)) return;
  await patchAgent(agent.id, { state: AGENT_STATES.GENERATING });
}

export async function handleResponse(tabId, assistantText, pageUrl) {
  const agent = await getAgentByTabId(tabId);
  if (!agent || agent.state === AGENT_STATES.PAUSED || TERMINAL_AGENT_STATES.has(agent.state)) return;

  const directive = parseAgentDirective(assistantText);
  await patchAgent(agent.id, {
    state: AGENT_STATES.EVALUATING,
    lastResponse: String(assistantText || "").slice(-12000),
    lastDirective: directive,
    conversationUrl: pageUrl || agent.conversationUrl
  });
  await patchTask(agent.taskId, { chatgpt_url: pageUrl || agent.conversationUrl });

  if (directive.status === "COMPLETE") {
    await updateState((state) => {
      const current = state.agents[agent.id];
      if (current) state.agents[agent.id] = { ...current, state: AGENT_STATES.COMPLETE, updatedAt: nowIso() };
      const run = state.runs[agent.runId];
      if (run) state.runs[agent.runId] = { ...run, status: AGENT_STATES.COMPLETE, completedAt: nowIso() };
      const task = state.tasks[agent.taskId];
      if (task) state.tasks[agent.taskId] = { ...task, status: "Done", next_action: directive.nextAction || task.next_action, updatedAt: nowIso() };
    });
    await pumpQueue();
    return;
  }

  if (directive.status === "BLOCKED") {
    await patchAgent(agent.id, { state: AGENT_STATES.NEEDS_USER });
    if (directive.nextAction) await patchTask(agent.taskId, { next_action: directive.nextAction });
    return;
  }

  const latestState = await getState();
  const latestAgent = latestState.agents[agent.id];
  if (!latestAgent) return;

  if (latestAgent.mode === EXECUTION_MODES.AUTO && directive.status === "CONTINUE") {
    const max = Math.max(1, Number(latestState.settings.maxAutoContinuations) || 1);
    if (latestAgent.continuationCount >= max) {
      await patchAgent(agent.id, {
        state: AGENT_STATES.NEEDS_USER,
        error: `Auto continuation limit (${max}) reached.`
      });
      return;
    }
    const task = latestState.tasks[agent.taskId];
    const continuationCount = latestAgent.continuationCount + 1;
    await patchAgent(agent.id, { continuationCount });
    await injectPrompt({ ...latestAgent, continuationCount }, buildContinuationPrompt(task, continuationCount));
    return;
  }

  await patchAgent(agent.id, { state: directive.status ? AGENT_STATES.RESPONSE_READY : AGENT_STATES.NEEDS_USER });
  if (directive.nextAction) await patchTask(agent.taskId, { next_action: directive.nextAction });
}

export async function continueTask(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found.");
  const agent = await getAgentByTaskId(taskId);
  if (!agent || !agent.tabId || !(await tabExists(agent.tabId))) {
    return startTask(taskId, EXECUTION_MODES.ASSISTED);
  }
  const continuationCount = (agent.continuationCount || 0) + 1;
  await patchAgent(agent.id, { continuationCount, state: AGENT_STATES.READY, error: "" });
  await injectPrompt({ ...agent, continuationCount }, buildContinuationPrompt(task, continuationCount));
  return (await getState()).agents[agent.id];
}

export async function pauseTask(taskId) {
  const agent = await getAgentByTaskId(taskId);
  if (!agent) return null;
  if (agent.tabId && await tabExists(agent.tabId)) {
    chrome.tabs.sendMessage(agent.tabId, { type: MESSAGE_TYPES.STOP_GENERATION }).catch(() => {});
  }
  await patchAgent(agent.id, { state: AGENT_STATES.PAUSED });
  await pumpQueue();
  return (await getState()).agents[agent.id];
}

export async function cancelTask(taskId) {
  const agent = await getAgentByTaskId(taskId);
  if (!agent) return null;
  if (agent.tabId && await tabExists(agent.tabId)) {
    chrome.tabs.sendMessage(agent.tabId, { type: MESSAGE_TYPES.STOP_GENERATION }).catch(() => {});
  }
  await updateState((state) => {
    const current = state.agents[agent.id];
    if (current) state.agents[agent.id] = { ...current, state: AGENT_STATES.CANCELLED, updatedAt: nowIso() };
    const run = state.runs[agent.runId];
    if (run) state.runs[agent.runId] = { ...run, status: AGENT_STATES.CANCELLED, completedAt: nowIso() };
  });
  await pumpQueue();
  return (await getState()).agents[agent.id];
}

export async function openTaskTab(taskId) {
  const agent = await getAgentByTaskId(taskId);
  if (!agent?.tabId || !(await tabExists(agent.tabId))) throw new Error("No active ChatGPT tab for this task.");
  const tab = await chrome.tabs.get(agent.tabId);
  await chrome.tabs.update(agent.tabId, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  return agent;
}

export async function pauseAll() {
  const state = await getState();
  for (const taskId of new Set(Object.values(state.agents).filter((a) => ACTIVE_STATES.has(a.state)).map((a) => a.taskId))) {
    await pauseTask(taskId);
  }
}

export async function resumeAll() {
  const state = await getState();
  const paused = Object.values(state.agents).filter((agent) => agent.state === AGENT_STATES.PAUSED);
  for (const agent of paused) {
    if (agent.tabId && await tabExists(agent.tabId)) {
      await patchAgent(agent.id, { state: AGENT_STATES.READY, error: "" });
    } else {
      await patchAgent(agent.id, { state: AGENT_STATES.QUEUED, tabId: null, error: "" });
    }
  }
  await pumpQueue();
}

export async function handleTabRemoved(tabId) {
  const agent = await getAgentByTabId(tabId);
  if (!agent || TERMINAL_AGENT_STATES.has(agent.state) || agent.state === AGENT_STATES.CANCELLED) return;
  await patchAgent(agent.id, {
    state: AGENT_STATES.ERROR,
    tabId: null,
    error: "ChatGPT tab was closed. Start the task again to create a new worker tab."
  });
  await pumpQueue();
}
