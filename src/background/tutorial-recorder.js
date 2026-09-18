import {
  getState,
  updateState,
  getTask,
  getAgentByTaskId
} from "../storage/repository.js";
import { MESSAGE_TYPES } from "../shared/constants.js";

const OFFSCREEN_PATH = "src/offscreen/recorder.html";
let creatingOffscreen = null;

function nowIso() {
  return new Date().toISOString();
}

function safeFilename(value) {
  const base = String(value || "tutorial")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "tutorial";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `ChatGPT Agents/${base} - ${stamp}.webm`;
}

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  if (contexts.length) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA", "BLOBS"],
      justification: "Record the controlled browser tab as a local tutorial video."
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

async function setRecording(taskId, patch) {
  return updateState((state) => {
    state.recordings ||= {};
    const previous = state.recordings[taskId] || {};
    state.recordings[taskId] = {
      ...previous,
      ...patch,
      taskId,
      updatedAt: nowIso()
    };
  });
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function captureStreamId(tabId) {
  await focusTab(tabId);
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (firstError) {
    try {
      return await chrome.tabCapture.getMediaStreamId();
    } catch {
      throw new Error(
        `Chrome could not start tab capture. Open the controlled browser tab, keep it active, then click Record Tutorial again. Original error: ${String(firstError?.message || firstError)}`
      );
    }
  }
}

export async function startTutorialRecording(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found.");
  if (!task.tutorial?.enabled) {
    throw new Error("This task is not marked as a tutorial task.");
  }

  const state = await getState();
  const active = Object.values(state.recordings || {}).find((item) =>
    ["starting", "recording", "stopping"].includes(item.status)
  );
  if (active) {
    throw new Error("Another tutorial recording is already active.");
  }

  const agent = await getAgentByTaskId(taskId);
  if (!agent?.auditTabId) {
    throw new Error("Start the tutorial task first so the controlled browser tab is available.");
  }

  const recordingId = `tutorial-${crypto.randomUUID()}`;
  const filename = safeFilename(task.tutorial.title || task.title);
  await setRecording(taskId, {
    id: recordingId,
    status: "starting",
    filename,
    tabId: agent.auditTabId,
    startedAt: nowIso(),
    stoppedAt: null,
    completedAt: null,
    error: ""
  });

  try {
    await ensureOffscreenDocument();
    const streamId = await captureStreamId(agent.auditTabId);
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: MESSAGE_TYPES.OFFSCREEN_START_TUTORIAL_RECORDING,
      streamId,
      recordingId,
      taskId,
      filename,
      includeAudio: task.tutorial.recordTabAudio !== false
    });
    if (!response?.ok) throw new Error(response?.error || "Offscreen recorder failed to start.");

    await setRecording(taskId, {
      status: "recording",
      mimeType: response.mimeType || "video/webm"
    });

    return (await getState()).recordings[taskId];
  } catch (error) {
    await setRecording(taskId, {
      status: "error",
      error: String(error?.message || error)
    });
    throw error;
  }
}

export async function stopTutorialRecording(taskId) {
  const state = await getState();
  const recording = state.recordings?.[taskId];
  if (!recording || !["starting", "recording"].includes(recording.status)) {
    throw new Error("No active tutorial recording for this task.");
  }

  await ensureOffscreenDocument();
  await setRecording(taskId, { status: "stopping", stoppedAt: nowIso() });

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: MESSAGE_TYPES.OFFSCREEN_STOP_TUTORIAL_RECORDING,
    recordingId: recording.id
  });
  if (!response?.ok) {
    await setRecording(taskId, {
      status: "error",
      error: response?.error || "Could not stop tutorial recording."
    });
    throw new Error(response?.error || "Could not stop tutorial recording.");
  }

  return (await getState()).recordings[taskId];
}

export async function handleTutorialRecordingReady(message) {
  const taskId = String(message.taskId || "");
  const state = await getState();
  const recording = state.recordings?.[taskId];
  if (!recording || recording.id !== message.recordingId) return null;

  try {
    const downloadId = await chrome.downloads.download({
      url: message.blobUrl,
      filename: message.filename || recording.filename,
      saveAs: false,
      conflictAction: "uniquify"
    });

    await setRecording(taskId, {
      status: "complete",
      completedAt: nowIso(),
      downloadId,
      bytes: Number(message.bytes) || 0,
      durationMs: Number(message.durationMs) || 0,
      mimeType: message.mimeType || recording.mimeType || "video/webm",
      error: ""
    });

    chrome.runtime.sendMessage({
      target: "offscreen",
      type: MESSAGE_TYPES.OFFSCREEN_REVOKE_RECORDING_URL,
      blobUrl: message.blobUrl
    }).catch(() => {});

    return (await getState()).recordings[taskId];
  } catch (error) {
    await setRecording(taskId, {
      status: "error",
      error: `Recording finished but download failed: ${String(error?.message || error)}`
    });
    throw error;
  }
}

export async function handleTutorialRecordingError(message) {
  const taskId = String(message.taskId || "");
  if (!taskId) return null;
  await setRecording(taskId, {
    status: "error",
    error: String(message.error || "Tutorial recording failed.")
  });
  return (await getState()).recordings[taskId];
}
