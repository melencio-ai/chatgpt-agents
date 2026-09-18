import {
  DEFAULT_SETTINGS,
  STORAGE_KEY
} from "../shared/constants.js";

function nowIso() {
  return new Date().toISOString();
}

export function createEmptyState() {
  return {
    version: 1,
    tasks: {},
    agents: {},
    runs: {},
    recordings: {},
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: nowIso()
  };
}

function mergeDefaults(value) {
  const base = createEmptyState();
  if (!value || typeof value !== "object") return base;
  return {
    ...base,
    ...value,
    tasks: value.tasks && typeof value.tasks === "object" ? value.tasks : {},
    agents: value.agents && typeof value.agents === "object" ? value.agents : {},
    runs: value.runs && typeof value.runs === "object" ? value.runs : {},
    recordings: value.recordings && typeof value.recordings === "object" ? value.recordings : {},
    settings: {
      ...DEFAULT_SETTINGS,
      ...(value.settings || {}),
      defaultMode: "auto",
      maxConcurrentAgents: 1,
      maxAutoContinuations: Math.max(
        40,
        Number(value.settings?.maxAutoContinuations) || 0
      )
    }
  };
}

export async function getState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return mergeDefaults(stored[STORAGE_KEY]);
}

export async function saveState(state) {
  const next = { ...state, updatedAt: nowIso() };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export async function updateState(mutator) {
  const current = await getState();
  const draft = structuredClone(current);
  const maybeNext = await mutator(draft);
  return saveState(maybeNext || draft);
}

export async function initializeState() {
  const current = await getState();
  return saveState(current);
}

export async function upsertTasks(tasks) {
  return updateState((state) => {
    for (const task of tasks) {
      const previous = state.tasks[task.id];
      state.tasks[task.id] = {
        ...previous,
        ...task,
        importedAt: previous?.importedAt || nowIso(),
        updatedAt: nowIso()
      };
    }
  });
}

export async function setSettings(patch) {
  return updateState((state) => {
    state.settings = {
      ...state.settings,
      ...patch,
      defaultMode: "auto",
      maxConcurrentAgents: 1,
      maxAutoContinuations: Math.max(
        5,
        Number(patch?.maxAutoContinuations ?? state.settings?.maxAutoContinuations) || 40
      )
    };
  });
}

export async function getTask(taskId) {
  const state = await getState();
  return state.tasks[taskId] || null;
}

export async function getAgentByTaskId(taskId) {
  const state = await getState();
  return Object.values(state.agents)
    .filter((agent) => agent.taskId === taskId)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

export async function getAgentByTabId(tabId) {
  const state = await getState();
  return Object.values(state.agents).find((agent) => agent.tabId === tabId) || null;
}
