import {
  AGENT_STATES,
  EXECUTION_MODES,
  TERMINAL_AGENT_STATES,
  MESSAGE_TYPES,
  normalizeMaxConcurrentAgents
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
import { completeSubtasks } from "../tasks/subtask-progress.js";
import {
  browserTargetUrl,
  isAutonomousBrowserTask,
  isInteractiveBrowserTask
} from "../tasks/browser-task.js";
import {
  MAX_AGENT_WAKE_ATTEMPTS,
  getAgentRecoveryDecision
} from "./agent-watchdog-policy.js";
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

const RECOVERABLE_CHAT_STATES = new Set([
  AGENT_STATES.INJECTING_PROMPT,
  AGENT_STATES.SUBMITTED,
  AGENT_STATES.GENERATING
]);

function responseTail(text) {
  return String(text || "").trim().slice(-16000);
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
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

async function recordCompletedSubtasks(taskId, completedSubtaskIds) {
  if (!Array.isArray(completedSubtaskIds) || !completedSubtaskIds.length) return;

  await updateState((state) => {
    const task = state.tasks[taskId];
    if (!task) return;

    const { subtasks, changed } = completeSubtasks(task.subtasks, completedSubtaskIds, nowIso());
    if (changed) {
      state.tasks[taskId] = { ...task, subtasks, updatedAt: nowIso() };
    }
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

async function ensureAgentAuditTab(agent, targetUrl) {
  const state = await getState();
  const claimedTabIds = Object.values(state.agents)
    .filter((other) =>
      other.id !== agent.id &&
      other.auditTabId &&
      !TERMINAL_AGENT_STATES.has(other.state)
    )
    .map((other) => other.auditTabId);

  return ensureAuditTab(targetUrl, agent.auditTabId, {
    excludedTabIds: claimedTabIds,
    reuseExisting: Boolean(agent.auditTabId)
  });
}

async function sendChatMessage(tabId, message) {
  let firstError = null;

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    firstError = error;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error("ChatGPT tab is no longer available.");
  }

  if (!String(tab.url || "").startsWith("https://chatgpt.com/")) {
    throw new Error(`ChatGPT receiver is unavailable because the tab is not on chatgpt.com: ${tab.url || "unknown URL"}`);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/chatgpt-content.js"]
    });
  } catch (error) {
    throw new Error(`Could not reattach the ChatGPT content script: ${String(error?.message || error)}`);
  }

  let lastError = firstError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 200 : 250));
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `ChatGPT content script did not become available after reinjection: ${String(lastError?.message || lastError || "unknown error")}`
  );
}

async function getChatState(agent) {
  if (!agent?.tabId || !(await tabExists(agent.tabId))) return null;
  try {
    const response = await sendChatMessage(agent.tabId, {
      type: MESSAGE_TYPES.GET_CHAT_STATE
    });
    return response?.ok ? response : null;
  } catch {
    return null;
  }
}

async function reconcileAgentChatState(agent, pageUrl = "") {
  const chatState = await getChatState(agent);
  if (!chatState) return false;

  const conversationUrl = chatState.url || pageUrl || agent.conversationUrl;
  if (chatState.generating) {
    if (agent.state !== AGENT_STATES.GENERATING) {
      await patchAgent(agent.id, {
        state: AGENT_STATES.GENERATING,
        conversationUrl,
        lastProgressAt: nowIso()
      });
    }
    return true;
  }

  const latest = String(chatState.latestAssistantText || "").trim();
  if (!latest) return false;

  const directive = parseAgentDirective(latest);
  if (!directive.status) return false;
  if (responseTail(latest) === responseTail(agent.lastResponse)) return false;

  await handleResponse(agent.tabId, latest, conversationUrl);
  return true;
}

async function waitForTabSettled(tabId, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        await new Promise((resolve) => setTimeout(resolve, 450));
        return true;
      }
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function focusBrowserTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // The browser tab may have closed between steps.
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
      lastPromptAt: null,
      lastProgressAt: timestamp,
      lastWakeAt: null,
      lastWakeReason: "",
      wakeAttemptCount: 0,
      recoveryExhausted: false,
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

  await patchAgent(agentId, { state: AGENT_STATES.CREATING_TAB, error: "", lastProgressAt: nowIso() });
  const targetUrl = task.chatgpt_url && task.chatgpt_url.startsWith("https://chatgpt.com/")
    ? task.chatgpt_url
    : "https://chatgpt.com/";

  const tab = await chrome.tabs.create({ url: targetUrl, active: true });
  await patchAgent(agentId, {
    tabId: tab.id,
    conversationUrl: tab.url || targetUrl,
    state: AGENT_STATES.WAITING_FOR_CHATGPT,
    lastProgressAt: nowIso()
  });

  await focusBrowserTab(tab.id);
  const loaded = await waitForTabSettled(tab.id, 20000);

  if (!loaded) {
    await patchAgent(agentId, {
      state: AGENT_STATES.ERROR,
      error: "ChatGPT tab did not finish loading within 20 seconds. Keep the opened ChatGPT tab active, then restart the task."
    });
    await pumpQueue();
    return;
  }

  try {
    const settledTab = await chrome.tabs.get(tab.id);
    await handlePageReady(tab.id, settledTab.url || targetUrl);
  } catch (error) {
    await patchAgent(agentId, {
      state: AGENT_STATES.ERROR,
      error: `ChatGPT tab did not finish loading: ${String(error?.message || error)}`
    });
    await pumpQueue();
  }
}

export async function pumpQueue() {
  const state = await getState();
  const limit = normalizeMaxConcurrentAgents(state.settings.maxConcurrentAgents);
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
  const mode = isAutonomousBrowserTask(task)
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

  await patchAgent(agent.id, {
    state: AGENT_STATES.INJECTING_PROMPT,
    error: "",
    lastPromptAt: nowIso(),
    lastProgressAt: nowIso()
  });
  try {
    const response = await sendChatMessage(agent.tabId, {
      type: MESSAGE_TYPES.INJECT_PROMPT,
      prompt
    });
    if (!response?.ok) throw new Error(response?.error || "Prompt injection failed.");
    await patchAgent(agent.id, { state: AGENT_STATES.SUBMITTED, lastProgressAt: nowIso() });
  } catch (error) {
    await patchAgent(agent.id, { state: AGENT_STATES.ERROR, error: String(error?.message || error) });
    await pumpQueue();
  }
}

async function attachObservation(agent, task, observation, stepNumber, actionResult = null, includeTaskBrief = false) {
  if (observation?.screenshot) {
    const filename = `audit-${task.id}-step-${stepNumber}.jpg`;
    const response = await sendChatMessage(agent.tabId, {
      type: MESSAGE_TYPES.ATTACH_IMAGE,
      base64: observation.screenshot,
      mimeType: "image/jpeg",
      filename,
      sourceUrl: observation?.snapshot?.url || browserTargetUrl(task) || ""
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
    lastProgressAt: nowIso(),
    lastBrowserObservation: {
      url: observation?.snapshot?.url || "",
      title: observation?.snapshot?.title || "",
      capturedAt: nowIso()
    }
  });

  await injectPrompt(agent, prompt);
}

async function startAutonomousAudit(agent, task) {
  const targetUrl = browserTargetUrl(task);
  const auditTab = await ensureAgentAuditTab(agent, targetUrl);
  await patchAgent(agent.id, { auditTabId: auditTab.id, state: AGENT_STATES.BROWSER_ACTING });

  if (isTutorialTask(task)) await focusBrowserTab(auditTab.id);
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
  await patchAgent(agent.id, { conversationUrl, lastProgressAt: nowIso() });
  await patchTask(agent.taskId, { chatgpt_url: conversationUrl });

  if (RECOVERABLE_CHAT_STATES.has(agent.state)) {
    await reconcileAgentChatState({ ...agent, conversationUrl }, conversationUrl);
    return;
  }

  if (![AGENT_STATES.CREATING_TAB, AGENT_STATES.WAITING_FOR_CHATGPT].includes(agent.state)) return;

  await patchAgent(agent.id, { state: AGENT_STATES.READY });
  if (agent.mode === EXECUTION_MODES.MANUAL) return;

  const task = await getTask(agent.taskId);

  if (isAutonomousBrowserTask(task)) {
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
  if (!agent || [AGENT_STATES.PAUSED, AGENT_STATES.COMPLETE, AGENT_STATES.CANCELLED].includes(agent.state)) return;
  await patchAgent(agent.id, { state: AGENT_STATES.GENERATING, lastProgressAt: nowIso() });
}

export async function enforceAgentLimit() {
  const state = await getState();
  const limit = normalizeMaxConcurrentAgents(state.settings.maxConcurrentAgents);
  const active = Object.values(state.agents)
    .filter((agent) => ACTIVE_STATES.has(agent.state))
    .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")));

  for (const agent of active.slice(limit)) {
    if (agent.tabId && await tabExists(agent.tabId)) {
      sendChatMessage(agent.tabId, { type: MESSAGE_TYPES.STOP_GENERATION }).catch(() => {});
    }
    await patchAgent(agent.id, { state: AGENT_STATES.PAUSED });
  }
}

export async function handleChatError(tabId, errorText, pageUrl = "") {
  const agent = await getAgentByTabId(tabId);
  if (!agent || [AGENT_STATES.PAUSED, AGENT_STATES.COMPLETE, AGENT_STATES.CANCELLED].includes(agent.state)) return;

  const message = String(errorText || "ChatGPT reported an unknown generation error.").trim().slice(0, 1000);
  await patchAgent(agent.id, {
    state: AGENT_STATES.ERROR,
    error: `ChatGPT reported: ${message}`,
    conversationUrl: pageUrl || agent.conversationUrl,
    lastProgressAt: nowIso(),
    recoveryExhausted: false
  });
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
        subtasks: (task.subtasks || []).map((subtask) => ({
          ...subtask,
          completed: true,
          completedAt: subtask.completedAt || nowIso()
        })),
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

  await patchAgent(agent.id, { state: AGENT_STATES.BROWSER_ACTING, error: "", lastProgressAt: nowIso() });

  let actionResult;
  let auditTab;
  try {
    const targetUrl = browserTargetUrl(task);
    auditTab = await ensureAgentAuditTab(current, targetUrl);
    await patchAgent(agent.id, { auditTabId: auditTab.id });
    if (isTutorialTask(task)) await focusBrowserTab(auditTab.id);

    actionResult = await executeBrowserAction(
      auditTab.id,
      targetUrl,
      directive.browserAction,
      {
        visualMouse: state.settings.visualMouse !== false,
        agentLabel: isTutorialTask(task) ? "Guide" : "Agent",
        tutorialMode: isTutorialTask(task),
        tutorialPace: task.tutorial?.pace || "guided",
        allowStateChanges: isInteractiveBrowserTask(task)
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
    auditTab = auditTab || await ensureAgentAuditTab(current, browserTargetUrl(task));
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
  if (!agent || [AGENT_STATES.PAUSED, AGENT_STATES.COMPLETE, AGENT_STATES.CANCELLED].includes(agent.state)) return;

  const response = responseTail(assistantText);
  if (!response || response === responseTail(agent.lastResponse)) return;

  const directive = parseAgentDirective(assistantText);
  await patchAgent(agent.id, {
    state: AGENT_STATES.EVALUATING,
    lastResponse: response,
    lastDirective: directive,
    conversationUrl: pageUrl || agent.conversationUrl,
    lastProgressAt: nowIso(),
    lastWakeAt: null,
    lastWakeReason: "",
    wakeAttemptCount: 0,
    recoveryExhausted: false,
    error: ""
  });

  await patchTask(agent.taskId, {
    chatgpt_url: pageUrl || agent.conversationUrl,
    ...(directive.nextAction ? { next_action: directive.nextAction } : {})
  });
  await recordCompletedSubtasks(agent.taskId, directive.completedSubtaskIds);

  const task = await getTask(agent.taskId);

  if (isAutonomousBrowserTask(task)) {
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
}

function buildWakeUpPrompt(task, agent, reason) {
  const recoveryHeader = `Continue the current task from where you stopped. Automatic recovery detected ${reason}. Do not repeat completed work. Return the required machine-readable status lines.`;
  const taskPrompt = agent.lastPromptAt || agent.lastResponse
    ? buildContinuationPrompt(task, Math.max(1, Number(agent.continuationCount) || 1))
    : buildInitialPrompt(task);
  return `${recoveryHeader}\n\n${taskPrompt}`;
}

export async function runAgentWatchdog(nowMs = Date.now()) {
  const snapshot = await getState();
  const candidates = Object.values(snapshot.agents)
    .sort((left, right) => String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")));

  for (const candidate of candidates) {
    const initialDecision = getAgentRecoveryDecision(candidate, nowMs);
    if (!initialDecision) continue;

    const currentState = await getState();
    const agent = currentState.agents[candidate.id];
    const decision = getAgentRecoveryDecision(agent, nowMs);
    if (!agent || !decision) continue;

    if (!agent.tabId || !(await tabExists(agent.tabId))) {
      await patchAgent(agent.id, {
        state: AGENT_STATES.ERROR,
        recoveryExhausted: true,
        error: "Automatic recovery could not continue because the ChatGPT tab is closed. Start the task again."
      });
      await pumpQueue();
      continue;
    }

    const chatState = await getChatState(agent);
    const latest = String(chatState?.latestAssistantText || "").trim();
    if (latest && responseTail(latest) !== responseTail(agent.lastResponse)) {
      const directive = parseAgentDirective(latest);
      if (directive.status) {
        await handleResponse(agent.tabId, latest, chatState?.url || agent.conversationUrl);
        continue;
      }
    }

    if (decision.exhausted) {
      await patchAgent(agent.id, {
        state: AGENT_STATES.ERROR,
        recoveryExhausted: true,
        error: `Automatic recovery stopped after ${MAX_AGENT_WAKE_ATTEMPTS} wake-up attempts. Last issue: ${decision.reason}.`
      });
      await pumpQueue();
      continue;
    }

    if (agent.state === AGENT_STATES.ERROR) {
      const latestState = await getState();
      const activeCount = Object.values(latestState.agents)
        .filter((item) => ACTIVE_STATES.has(item.state)).length;
      const limit = normalizeMaxConcurrentAgents(latestState.settings.maxConcurrentAgents);
      if (activeCount >= limit) continue;
    }

    if (chatState?.generating) {
      try {
        await sendChatMessage(agent.tabId, { type: MESSAGE_TYPES.STOP_GENERATION });
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch {
        // Prompt injection below will retry/reinject the content script if needed.
      }
    }

    const task = currentState.tasks[agent.taskId];
    if (!task) continue;

    const wakeAttemptCount = decision.attempts + 1;
    const wakeAt = new Date(nowMs).toISOString();
    await patchAgent(agent.id, {
      state: AGENT_STATES.READY,
      wakeAttemptCount,
      lastWakeAt: wakeAt,
      lastWakeReason: decision.reason,
      recoveryExhausted: false,
      error: ""
    });
    await injectPrompt(
      { ...agent, state: AGENT_STATES.READY, wakeAttemptCount, lastWakeAt: wakeAt },
      buildWakeUpPrompt(task, agent, decision.reason)
    );
  }
}

export async function continueTask(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found.");
  const agent = await getAgentByTaskId(taskId);
  if (!agent || !agent.tabId || !(await tabExists(agent.tabId))) {
    return startTask(taskId, EXECUTION_MODES.AUTO);
  }

  if (isAutonomousBrowserTask(task)) {
    const prompt = isTutorialTask(task)
      ? `Resume the read-only tutorial walkthrough from the current browser state. Move in small visible teaching steps and emit exactly one safe BROWSER_ACTION.`
      : isInteractiveBrowserTask(task)
        ? `Resume the authorized interactive browser automation from the current state. Perform only the actions explicitly stated in the task and emit exactly one BROWSER_ACTION.`
        : `Resume the autonomous read-only browser audit from the current state. Use the browser yourself and emit exactly one safe BROWSER_ACTION.`;
    await patchAgent(agent.id, {
      state: AGENT_STATES.READY,
      error: "",
      lastProgressAt: nowIso(),
      lastWakeAt: null,
      lastWakeReason: "",
      wakeAttemptCount: 0,
      recoveryExhausted: false
    });
    await injectPrompt(agent, prompt);
    return (await getState()).agents[agent.id];
  }

  const continuationCount = (agent.continuationCount || 0) + 1;
  await patchAgent(agent.id, {
    continuationCount,
    state: AGENT_STATES.READY,
    error: "",
    lastProgressAt: nowIso(),
    lastWakeAt: null,
    lastWakeReason: "",
    wakeAttemptCount: 0,
    recoveryExhausted: false
  });
  await injectPrompt({ ...agent, continuationCount }, buildContinuationPrompt(task, continuationCount));
  return (await getState()).agents[agent.id];
}

export async function pauseTask(taskId) {
  const agent = await getAgentByTaskId(taskId);
  if (!agent) return null;
  if (agent.tabId && await tabExists(agent.tabId)) {
    sendChatMessage(agent.tabId, { type: MESSAGE_TYPES.STOP_GENERATION }).catch(() => {});
  }
  await patchAgent(agent.id, { state: AGENT_STATES.PAUSED });
  await pumpQueue();
  return (await getState()).agents[agent.id];
}

export async function cancelTask(taskId) {
  const agent = await getAgentByTaskId(taskId);
  if (!agent) return null;
  if (agent.tabId && await tabExists(agent.tabId)) {
    sendChatMessage(agent.tabId, { type: MESSAGE_TYPES.STOP_GENERATION }).catch(() => {});
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
        await sendChatMessage(agent.tabId, { type: MESSAGE_TYPES.STOP_GENERATION });
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
  const limit = normalizeMaxConcurrentAgents(state.settings.maxConcurrentAgents);
  const activeCount = Object.values(state.agents).filter((agent) => ACTIVE_STATES.has(agent.state)).length;
  const resumable = paused.slice(0, Math.max(0, limit - activeCount));
  for (const agent of resumable) {
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
