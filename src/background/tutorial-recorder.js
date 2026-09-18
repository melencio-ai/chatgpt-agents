import {
  getState,
  updateState,
  getTask,
  getAgentByTaskId
} from "../storage/repository.js";
import { MESSAGE_TYPES } from "../shared/constants.js";
import {
  acquireDebuggerSession,
  releaseDebuggerSession
} from "./browser-operator.js";

const OFFSCREEN_PATH = "src/offscreen/recorder.html";
const DEFAULT_FPS = 10;
const activeScreencasts = new Map();
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
      reasons: ["BLOBS"],
      justification: "Encode debugger screencast frames into a local tutorial video."
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

function sessionForTab(tabId) {
  return Array.from(activeScreencasts.values())
    .find((item) => item.tabId === tabId) || null;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Page.screencastFrame" || !source?.tabId) return;

  const session = sessionForTab(source.tabId);
  if (!session) {
    chrome.debugger.sendCommand(source, "Page.screencastFrameAck", {
      sessionId: params.sessionId
    }).catch(() => {});
    return;
  }

  chrome.debugger.sendCommand(source, "Page.screencastFrameAck", {
    sessionId: params.sessionId
  }).catch(() => {});

  const now = Date.now();
  const minGap = 1000 / Math.max(1, session.fps || DEFAULT_FPS);
  if (now - session.lastFrameAt < minGap) return;
  session.lastFrameAt = now;

  chrome.runtime.sendMessage({
    target: "offscreen",
    type: MESSAGE_TYPES.OFFSCREEN_TUTORIAL_FRAME,
    recordingId: session.recordingId,
    taskId: session.taskId,
    data: params.data
  }).catch(() => {});
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source?.tabId) return;
  const session = sessionForTab(source.tabId);
  if (!session) return;

  activeScreencasts.delete(session.taskId);
  setRecording(session.taskId, {
    status: "error",
    error: `Debugger recording session ended unexpectedly: ${reason || "detached"}`
  }).catch(() => {});

  chrome.runtime.sendMessage({
    target: "offscreen",
    type: MESSAGE_TYPES.OFFSCREEN_STOP_TUTORIAL_RECORDING,
    recordingId: session.recordingId
  }).catch(() => {});
});

async function viewportSize(debuggee) {
  try {
    const metrics = await chrome.debugger.sendCommand(debuggee, "Page.getLayoutMetrics");
    const viewport = metrics?.cssVisualViewport || metrics?.cssLayoutViewport;
    const width = Math.max(320, Math.round(Number(viewport?.clientWidth) || 1280));
    const height = Math.max(240, Math.round(Number(viewport?.clientHeight) || 720));
    return { width, height };
  } catch {
    return { width: 1280, height: 720 };
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
  const fps = Math.max(4, Math.min(15, Number(task.tutorial.fps) || DEFAULT_FPS));

  await setRecording(taskId, {
    id: recordingId,
    status: "starting",
    filename,
    tabId: agent.auditTabId,
    startedAt: nowIso(),
    stoppedAt: null,
    completedAt: null,
    error: "",
    source: "cdp-screencast",
    audioIncluded: false
  });

  let debuggee = null;

  try {
    await ensureOffscreenDocument();
    debuggee = await acquireDebuggerSession(agent.auditTabId);
    const { width, height } = await viewportSize(debuggee);

    const offscreen = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: MESSAGE_TYPES.OFFSCREEN_START_TUTORIAL_RECORDING,
      recordingId,
      taskId,
      filename,
      width,
      height,
      fps
    });
    if (!offscreen?.ok) {
      throw new Error(offscreen?.error || "Offscreen recorder failed to start.");
    }

    activeScreencasts.set(taskId, {
      taskId,
      recordingId,
      tabId: agent.auditTabId,
      debuggee,
      fps,
      lastFrameAt: 0
    });

    await chrome.debugger.sendCommand(debuggee, "Page.startScreencast", {
      format: "jpeg",
      quality: 68,
      maxWidth: Math.min(1920, width),
      maxHeight: Math.min(1080, height),
      everyNthFrame: 1
    });

    try {
      const initial = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 68,
        fromSurface: true,
        captureBeyondViewport: false
      });
      if (initial?.data) {
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: MESSAGE_TYPES.OFFSCREEN_TUTORIAL_FRAME,
          recordingId,
          taskId,
          data: initial.data
        });
      }
    } catch {
      // Screencast frames will still populate the recorder.
    }

    await setRecording(taskId, {
      status: "recording",
      mimeType: offscreen.mimeType || "video/webm",
      width,
      height,
      fps
    });

    return (await getState()).recordings[taskId];
  } catch (error) {
    activeScreencasts.delete(taskId);

    if (debuggee) {
      try {
        await chrome.debugger.sendCommand(debuggee, "Page.stopScreencast");
      } catch {
        // Screencast may not have started.
      }
      await releaseDebuggerSession(agent.auditTabId);
    }

    chrome.runtime.sendMessage({
      target: "offscreen",
      type: MESSAGE_TYPES.OFFSCREEN_STOP_TUTORIAL_RECORDING,
      recordingId
    }).catch(() => {});

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

  const session = activeScreencasts.get(taskId);
  if (session) {
    activeScreencasts.delete(taskId);
    try {
      await chrome.debugger.sendCommand(session.debuggee, "Page.stopScreencast");
    } catch {
      // The target may have already stopped producing frames.
    }
    await releaseDebuggerSession(session.tabId);
  }

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

  const session = activeScreencasts.get(taskId);
  if (session) {
    activeScreencasts.delete(taskId);
    try {
      await chrome.debugger.sendCommand(session.debuggee, "Page.stopScreencast");
    } catch {
      // Ignore cleanup errors.
    }
    await releaseDebuggerSession(session.tabId);
  }

  await setRecording(taskId, {
    status: "error",
    error: String(message.error || "Tutorial recording failed.")
  });
  return (await getState()).recordings[taskId];
}
