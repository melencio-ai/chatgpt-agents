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
  buildBrowserObservationPrompt,
  parseAgentDirective
} from "../tasks/prompt-builder.js";
import {
  ensureAuditTab,
  observeAuditPage,
  executeBrowserAction
} from "./browser-operator.js";

const ACTIVE_STATES = new Set([
  AGENT_STATES.CREATING_TAB,
  AGENT_STATES.WAITING_FOR_CHATGPT,
  AGENT_STATES.READY,
  AGENT_STATES.INJECTING_PROMPT,
  AGENT_STATES.SUBMITTED,
  AGENT_STATES.GENERATING,
  AGENT_STATES.RESPONSE_READY,
  AGENT_STATES.EVALUATING,
  AGENT_STATES.BROWSER_ACTING,
  AGENT_STATES.NEEDS_USER
]);

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function isAutonomousAudit(task) {
  return Boolean(task?.audit_target?.url && String(task.audit_mode || "").toLowerCase().includes("read"));
}

function isTutorialTask(task) {
  return Boolean(task?.tutorial?.enabled);
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

async function waitForTabSettled(tabId, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        await new Promise((resolve) => setTimeout(resolve, 450));
        return;
      }
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
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
      auditTabId: null,
      conversationUrl: "",
      mode,
      state: AGENT_STATES.QUEUED,
      continuationCount: 0,
      browserStepCount: 0,
      lastResponse: "",
      lastDirective: null,
      lastBrowserObservation: null,
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

  // Deliberately one browser-owning agent at a time. This prevents multiple
  // audit conversations from fighting over the same authenticated app tab.
  const limit = 1;
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

export async function startTask(taskId, requestedMode, forceRestart = false) {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found.");

  const previous = await getAgentByTaskId(taskId);

  if (previous && forceRestart) {
    await updateState((state) => {
      const current = state.agents[previous.id];
      if (current) {
        state.agents[previous.id] = {
          ...current,
          state: AGENT_STATES.CANCELLED,
          updatedAt: nowIso(),
          error: "Restarted by user."
        };
      }
      const run = state.runs[previous.runId];
      if (run) {
        state.runs[previous.runId] = {
          ...run,
          status: AGENT_STATES.CANCELLED,
          completedAt: nowIso()
        };
      }
      const currentTask = state.tasks[taskId];
      if (currentTask) {
        state.tasks[taskId] = {
          ...currentTask,
          chatgpt_url: "",
          status: "Now",
          updatedAt: nowIso()
        };
      }
    });

    if (previous.tabId && await tabExists(previous.tabId)) {
      try {
        await chrome.tabs.remove(previous.tabId);
      } catch {
        // The old worker tab may already be closing.
      }
    }
  } else if (previous && !TERMINAL_AGENT_STATES.has(previous.state) && previous.state !== AGENT_STATES.PAUSED) {
    if (await tabExists(previous.tabId)) return previous;
  }

  const state = await getState();
  const mode = isAutonomousAudit(task)
    ? EXECUTION_MODES.AUTO
    : (Object.values(EXECUTION_MODES).includes(requestedMode) ? requestedMode : state.settings.defaultMode);

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

async function attachObservation(agent, task, observation, stepNumber, actionResult = null, includeTaskBrief = false) {
  if (observation?.screenshot) {
    const filename = `audit-${task.id}-step-${stepNumber}.jpg`;
    const response = await chrome.tabs.sendMessage(agent.tabId, {
      type: MESSAGE_TYPES.ATTACH_IMAGE,
      base64: observation.screenshot,
      mimeType: "image/jpeg",
      filename,
      sourceUrl: observation?.snapshot?.url || task.audit_target?.url || ""
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not attach browser screenshot to ChatGPT.");
    }
  }

  const browserPrompt = buildBrowserObservationPrompt(task, observation, stepNumber, actionResult);
  const prompt = includeTaskBrief
    ? `${buildInitialPrompt(task)}\n\n--- CURRENT BROWSER STATE ---\n\n${browserPrompt}`
    : browserPrompt;

  await patchAgent(agent.id, {
    browserStepCount: stepNumber,
    lastBrowserObservation: {
      url: observation?.snapshot?.url || "",
      title: observation?.snapshot?.title || "",
      capturedAt: nowIso()
    }
  });

  await injectPrompt(agent, prompt);
}

async function startAutonomousAudit(agent, task) {
  const auditTab = await ensureAuditTab(task.audit_target.url, agent.auditTabId);
  await patchAgent(agent.id, { auditTabId: auditTab.id, state: AGENT_STATES.BROWSER_ACTING });

  await waitForTabSettled(auditTab.id);
  const state = await getState();
  const tutorialMode = isTutorialTask(task);
  const observation = await observeAuditPage(auditTab.id, {
    visualMouse: state.settings.visualMouse !== false,
    agentLabel: tutorialMode ? "Guide" : "Agent"
  });
  await attachObservation(
    { ...agent, auditTabId: auditTab.id },
    task,
    observation,
    1,
    null,
    true
  );
}

export async function handlePageReady(tabId, pageUrl) {
  const agent = await getAgentByTabId(tabId);
  if (!agent || TERMINAL_AGENT_STATES.has(agent.state) || agent.state === AGENT_STATES.CANCELLED) return;

  const conversationUrl = pageUrl || agent.conversationUrl;
  await patchAgent(agent.id, { conversationUrl });
  await patchTask(agent.taskId, { chatgpt_url: conversationUrl });

  if (![AGENT_STATES.CREATING_TAB, AGENT_STATES.WAITING_FOR_CHATGPT].includes(agent.state)) return;

  await patchAgent(agent.id, { state: AGENT_STATES.READY });
  if (agent.mode === EXECUTION_MODES.MANUAL) return;

  const task = await getTask(agent.taskId);

  if (isAutonomousAudit(task)) {
    try {
      await startAutonomousAudit({ ...agent, tabId, conversationUrl }, task);
    } catch (error) {
      await patchAgent(agent.id, {
        state: AGENT_STATES.NEEDS_USER,
        error: `Browser audit could not start: ${String(error?.message || error)}`
      });
    }
    return;
  }

  await injectPrompt({ ...agent, tabId, conversationUrl }, buildInitialPrompt(task));
}

export async function markGenerating(tabId) {
  const agent = await getAgentByTabId(tabId);
  if (!agent || agent.state === AGENT_STATES.PAUSED || TERMINAL_AGENT_STATES.has(agent.state)) return;
  await patchAgent(agent.id, { state: AGENT_STATES.GENERATING });
}

async function finishAgent(agent, directive) {
  await updateState((state) => {
    const current = state.agents[agent.id];
    if (current) state.agents[agent.id] = { ...current, state: AGENT_STATES.COMPLETE, updatedAt: nowIso() };
    const run = state.runs[agent.runId];
    if (run) state.runs[agent.runId] = { ...run, status: AGENT_STATES.COMPLETE, completedAt: nowIso() };
    const task = state.tasks[agent.taskId];
    if (task) {
      state.tasks[agent.taskId] = {
        ...task,
        status: "Done",
        next_action: directive.nextAction || task.next_action,
        updatedAt: nowIso()
      };
    }
  });
  await pumpQueue();
}

async function continueAutonomousAudit(agent, task, directive) {
  const state = await getState();
  const current = state.agents[agent.id];
  if (!current) return;

  const maxSteps = Math.max(1, Number(state.settings.maxAutoContinuations) || 40);
  const currentStep = Number(current.browserStepCount || 1);
  if (currentStep >= maxSteps) {
    await patchAgent(agent.id, {
      state: AGENT_STATES.NEEDS_USER,
      error: `Autonomous browser step limit (${maxSteps}) reached.`
    });
    return;
  }

  if (directive.browserAction === undefined) {
    const repairPrompt = `Your last response did not contain a valid BROWSER_ACTION JSON line. Continue the same audit and provide exactly one safe browser action using the required machine-readable format. Do not ask the user to navigate for you.`;
    await injectPrompt(current, repairPrompt);
    return;
  }

  if (directive.browserAction === null) {
    if (directive.status === "COMPLETE") {
      await finishAgent(agent, directive);
      return;
    }
    await patchAgent(agent.id, {
      state: AGENT_STATES.NEEDS_USER,
      error: "Agent returned BROWSER_ACTION: null before marking the audit complete."
    });
    return;
  }

  await patchAgent(agent.id, { state: AGENT_STATES.BROWSER_ACTING, error: "" });

  let actionResult;
  let auditTab;
  try {
    auditTab = await ensureAuditTab(task.audit_target.url, current.auditTabId);
    await patchAgent(agent.id, { auditTabId: auditTab.id });

    actionResult = await executeBrowserAction(
      auditTab.id,
      task.audit_target.url,
      directive.browserAction,
      {
        visualMouse: state.settings.visualMouse !== false,
        agentLabel: isTutorialTask(task) ? "Guide" : "Agent",
        tutorialMode: isTutorialTask(task),
        tutorialPace: task.tutorial?.pace || "guided"
      }
    );

    await waitForTabSettled(auditTab.id);
  } catch (error) {
    const message = String(error?.message || error);
    actionResult = { ok: false, error: message, requestedAction: directive.browserAction };

    if (/outside audit origin|restricted by policy|captcha|login|sign in|authentication/i.test(message)) {
      await patchAgent(agent.id, {
        state: AGENT_STATES.NEEDS_USER,
        error: message
      });
      return;
    }
  }

  try {
    auditTab = auditTab || await ensureAuditTab(task.audit_target.url, current.auditTabId);
    const observation = await observeAuditPage(auditTab.id, {
      visualMouse: state.settings.visualMouse !== false,
      agentLabel: isTutorialTask(task) ? "Guide" : "Agent"
    });
    const nextStep = currentStep + 1;
    await attachObservation(
      { ...current, auditTabId: auditTab.id },
      task,
      observation,
      nextStep,
      actionResult,
      false
    );
  } catch (error) {
    await patchAgent(agent.id, {
      state: AGENT_STATES.NEEDS_USER,
      error: `Could not observe the browser after the action: ${String(error?.message || error)}`
    });
  }
}

export async function handleResponse(tabId, assistantText, pageUrl) {
  const agent = await getAgentByTabId(tabId);
  if (!agent || agent.state === AGENT_STATES.PAUSED || TERMINAL_AGENT_STATES.has(agent.state)) return;

  const directive = parseAgentDirective(assistantText);
  await patchAgent(agent.id, {
    state: AGENT_STATES.EVALUATING,
    lastResponse: String(assistantText || "").slice(-16000),
    lastDirective: directive,
    conversationUrl: pageUrl || agent.conversationUrl
  });
  await patchTask(agent.taskId, { chatgpt_url: pageUrl || agent.conversationUrl });

  const task = await getTask(agent.taskId);

  if (isAutonomousAudit(task)) {
    if (directive.status === "COMPLETE") {
      await finishAgent(agent, directive);
      return;
    }

    if (directive.status === "BLOCKED" && (directive.browserAction === null || directive.browserAction === undefined)) {
      await patchAgent(agent.id, {
        state: AGENT_STATES.NEEDS_USER,
        error: directive.nextAction || "Audit requires human input."
      });
      if (directive.nextAction) await patchTask(agent.taskId, { next_action: directive.nextAction });
      return;
    }

    await continueAutonomousAudit(agent, task, directive);
    return;
  }

  if (directive.status === "COMPLETE") {
    await finishAgent(agent, directive);
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
    const continuationCount = latestAgent.continuationCount + 1;
    await patchAgent(agent.id, { continuationCount });
    await injectPrompt(
      { ...latestAgent, continuationCount },
      buildContinuationPrompt(task, continuationCount)
    );
    return;
  }

  await patchAgent(agent.id, {
    state: directive.status ? AGENT_STATES.RESPONSE_READY : AGENT_STATES.NEEDS_USER
  });
  if (directive.nextAction) await patchTask(agent.taskId, { next_action: directive.nextAction });
}

export async function continueTask(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found.");
  const agent = await getAgentByTaskId(taskId);
  if (!agent || !agent.tabId || !(await tabExists(agent.tabId))) {
    return startTask(taskId, EXECUTION_MODES.AUTO);
  }

  if (isAutonomousAudit(task)) {
    const prompt = isTutorialTask(task)
      ? `Resume the read-only tutorial walkthrough from the current browser state. Move in small visible teaching steps and emit exactly one safe BROWSER_ACTION.`
      : `Resume the autonomous read-only browser audit from the current state. Use the browser yourself and emit exactly one safe BROWSER_ACTION.`;
    await patchAgent(agent.id, {
      state: AGENT_STATES.READY,
      error: ""
    });
    await injectPrompt(agent, prompt);
    return (await getState()).agents[agent.id];
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

export async function deleteTask(taskId) {
  const state = await getState();
  const task = state.tasks[taskId];
  if (!task) return false;

  const taskAgents = Object.values(state.agents).filter((agent) => agent.taskId === taskId);

  for (const agent of taskAgents) {
    if (agent.tabId && await tabExists(agent.tabId)) {
      try {
        await chrome.tabs.sendMessage(agent.tabId, { type: MESSAGE_TYPES.STOP_GENERATION });
      } catch {
        // The content script may no longer be available.
      }
      try {
        await chrome.tabs.remove(agent.tabId);
      } catch {
        // Tab may already be closed.
      }
    }
  }

  await updateState((draft) => {
    delete draft.tasks[taskId];

    for (const [agentId, agent] of Object.entries(draft.agents)) {
      if (agent.taskId === taskId) delete draft.agents[agentId];
    }

    for (const [runId, run] of Object.entries(draft.runs)) {
      if (run.taskId === taskId) delete draft.runs[runId];
    }
  });

  await pumpQueue();
  return true;
}

export async function openTaskTab(taskId) {
  const agent = await getAgentByTaskId(taskId);
  if (!agent?.tabId || !(await tabExists(agent.tabId))) throw new Error("No active ChatGPT tab for this task.");
  const tab = await chrome.tabs.get(agent.tabId);
  await chrome.tabs.update(agent.tabId, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  return agent;
}

export async function openBrowserTab(taskId) {
  const agent = await getAgentByTaskId(taskId);
  if (!agent?.auditTabId || !(await tabExists(agent.auditTabId))) {
    throw new Error("No controlled browser tab is available yet. Start the task first.");
  }
  const tab = await chrome.tabs.get(agent.auditTabId);
  await chrome.tabs.update(agent.auditTabId, { active: true });
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
  const state = await getState();

  const chatAgent = Object.values(state.agents).find((agent) => agent.tabId === tabId);
  if (chatAgent && !TERMINAL_AGENT_STATES.has(chatAgent.state) && chatAgent.state !== AGENT_STATES.CANCELLED) {
    await patchAgent(chatAgent.id, {
      state: AGENT_STATES.ERROR,
      tabId: null,
      error: "ChatGPT tab was closed. Start the task again to create a new worker tab."
    });
    await pumpQueue();
    return;
  }

  const auditAgent = Object.values(state.agents).find((agent) => agent.auditTabId === tabId);
  if (auditAgent && !TERMINAL_AGENT_STATES.has(auditAgent.state)) {
    await patchAgent(auditAgent.id, {
      auditTabId: null,
      state: AGENT_STATES.NEEDS_USER,
      error: "Audit browser tab was closed. Continue the task to reopen it."
    });
  }
}
