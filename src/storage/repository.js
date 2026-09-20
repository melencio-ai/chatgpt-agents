import {
  DEFAULT_SETTINGS,
  STORAGE_KEY
} from "../shared/constants.js";

function nowIso() {
  return new Date().toISOString();
}

export function createEmptyState() {
  return {
    version: 2,
    tasks: {},
    agents: {},
    runs: {},
    detectedTaskPayloads: {},
    lastTaskDetection: null,
    settings: { ...DEFAULT_SETTINGS },
    updatedAt: nowIso()
  };
}

function mergeDefaults(value) {
  const base = createEmptyState();
  if (!value || typeof value !== "object") return base;

  const { recordings: _legacyRecordings, ...rest } = value;
  const tasks = value.tasks && typeof value.tasks === "object"
    ? Object.fromEntries(Object.entries(value.tasks).map(([id, task]) => {
        if (!task?.tutorial || typeof task.tutorial !== "object") return [id, task];
        const { recordTabAudio: _recordTabAudio, fps: _fps, ...tutorial } = task.tutorial;
        return [id, { ...task, tutorial }];
      }))
    : {};

  return {
    ...base,
    ...rest,
    version: base.version,
    tasks,
    agents: value.agents && typeof value.agents === "object" ? value.agents : {},
    runs: value.runs && typeof value.runs === "object" ? value.runs : {},
    detectedTaskPayloads: value.detectedTaskPayloads && typeof value.detectedTaskPayloads === "object"
      ? value.detectedTaskPayloads
      : {},
    lastTaskDetection: value.lastTaskDetection && typeof value.lastTaskDetection === "object"
      ? value.lastTaskDetection
      : null,
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

export async function recordDetectedTaskPayload({
  fingerprint,
  tasks,
  sourceUrl = "",
  autoImport = true
}) {
  let result = {
    duplicate: false,
    importedTaskIds: [],
    skippedExisting: 0
  };

  const state = await updateState((state) => {
    const now = nowIso();
    const existing = state.detectedTaskPayloads[fingerprint] || null;

    if (existing?.importedAt || (existing && !autoImport)) {
      result = {
        duplicate: true,
        importedTaskIds: [],
        skippedExisting: existing.skippedExisting || 0
      };
      return state;
    }

    const importedTaskIds = [];
    let skippedExisting = 0;

    if (autoImport) {
      for (const task of tasks) {
        if (state.tasks[task.id]) {
          skippedExisting += 1;
          continue;
        }

        state.tasks[task.id] = {
          ...task,
          importedAt: now,
          updatedAt: now
        };
        importedTaskIds.push(task.id);
      }
    }

    state.detectedTaskPayloads[fingerprint] = {
      fingerprint,
      sourceUrl,
      taskIds: tasks.map((task) => task.id),
      taskCount: tasks.length,
      detectedAt: existing?.detectedAt || now,
      importedAt: autoImport ? now : null,
      importedTaskIds,
      skippedExisting
    };

    const detectionEntries = Object.entries(state.detectedTaskPayloads)
      .sort(([, left], [, right]) => String(right.detectedAt || "").localeCompare(String(left.detectedAt || "")));
    for (const [oldFingerprint] of detectionEntries.slice(200)) {
      delete state.detectedTaskPayloads[oldFingerprint];
    }

    state.lastTaskDetection = {
      fingerprint,
      detectedAt: existing?.detectedAt || now,
      activityAt: now,
      sourceUrl,
      taskCount: tasks.length,
      importedCount: importedTaskIds.length,
      skippedExisting,
      autoImported: Boolean(autoImport)
    };

    result = {
      duplicate: false,
      importedTaskIds,
      skippedExisting
    };

    return state;
  });

  return { state, ...result };
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
