import { MESSAGE_TYPES } from "../shared/constants.js";

let mediaRecorder = null;
let canvas = null;
let context = null;
let canvasStream = null;
let chunks = [];
let activeRecording = null;
let frameChain = Promise.resolve();

function preferredMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  return candidates.find((value) => MediaRecorder.isTypeSupported(value)) || "";
}

function cleanupRecorder() {
  try {
    canvasStream?.getTracks().forEach((track) => track.stop());
  } catch {
    // Stream may already be stopped.
  }

  canvasStream = null;
  canvas = null;
  context = null;
  mediaRecorder = null;
  chunks = [];
  activeRecording = null;
  frameChain = Promise.resolve();
}

function base64JpegToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "image/jpeg" });
}

async function drawFrame(base64, recordingId) {
  if (!activeRecording || activeRecording.recordingId !== recordingId || !canvas || !context) return;

  const bitmap = await createImageBitmap(base64JpegToBlob(base64));
  try {
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
}

async function startRecording(message) {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    throw new Error("A tutorial recording is already running.");
  }

  const width = Math.max(320, Math.round(Number(message.width) || 1280));
  const height = Math.max(240, Math.round(Number(message.height) || 720));
  const fps = Math.max(4, Math.min(15, Number(message.fps) || 10));

  canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  context = canvas.getContext("2d", {
    alpha: false,
    desynchronized: true
  });

  if (!context) throw new Error("Could not initialize tutorial recording canvas.");

  context.fillStyle = "#111827";
  context.fillRect(0, 0, width, height);

  canvasStream = canvas.captureStream(fps);
  const mimeType = preferredMimeType();
  chunks = [];
  activeRecording = {
    recordingId: message.recordingId,
    taskId: message.taskId,
    filename: message.filename,
    startedAt: Date.now(),
    width,
    height,
    fps
  };

  mediaRecorder = mimeType
    ? new MediaRecorder(canvasStream, {
        mimeType,
        videoBitsPerSecond: 4_500_000
      })
    : new MediaRecorder(canvasStream, {
        videoBitsPerSecond: 4_500_000
      });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };

  mediaRecorder.onerror = (event) => {
    chrome.runtime.sendMessage({
      target: "service-worker",
      type: MESSAGE_TYPES.TUTORIAL_RECORDING_ERROR,
      recordingId: activeRecording?.recordingId,
      taskId: activeRecording?.taskId,
      error: event?.error?.message || "MediaRecorder failed."
    }).catch(() => {});
  };

  mediaRecorder.onstop = async () => {
    const recording = activeRecording;
    try {
      await frameChain.catch(() => {});
      const type = mediaRecorder?.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunks, { type });
      const blobUrl = URL.createObjectURL(blob);

      await chrome.runtime.sendMessage({
        target: "service-worker",
        type: MESSAGE_TYPES.TUTORIAL_RECORDING_READY,
        recordingId: recording?.recordingId,
        taskId: recording?.taskId,
        filename: recording?.filename,
        blobUrl,
        mimeType: type,
        bytes: blob.size,
        durationMs: Math.max(0, Date.now() - Number(recording?.startedAt || Date.now())),
        width: recording?.width,
        height: recording?.height,
        fps: recording?.fps
      });
    } finally {
      cleanupRecorder();
    }
  };

  mediaRecorder.start(1000);

  return {
    recording: true,
    mimeType: mediaRecorder.mimeType || mimeType || "video/webm",
    width,
    height,
    fps
  };
}

function enqueueFrame(message) {
  if (!message.data) return { accepted: false };
  if (!activeRecording || activeRecording.recordingId !== message.recordingId) {
    return { accepted: false };
  }

  frameChain = frameChain
    .then(() => drawFrame(message.data, message.recordingId))
    .catch((error) => {
      chrome.runtime.sendMessage({
        target: "service-worker",
        type: MESSAGE_TYPES.TUTORIAL_RECORDING_ERROR,
        recordingId: activeRecording?.recordingId,
        taskId: activeRecording?.taskId,
        error: `Could not encode tutorial frame: ${String(error?.message || error)}`
      }).catch(() => {});
    });

  return { accepted: true };
}

function stopRecording(message) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    throw new Error("No tutorial recording is currently running.");
  }
  if (message.recordingId && activeRecording?.recordingId !== message.recordingId) {
    throw new Error("Recording ID does not match the active tutorial recording.");
  }

  mediaRecorder.stop();
  return { stopping: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;

  (async () => {
    try {
      switch (message.type) {
        case MESSAGE_TYPES.OFFSCREEN_START_TUTORIAL_RECORDING:
          sendResponse({ ok: true, ...(await startRecording(message)) });
          break;
        case MESSAGE_TYPES.OFFSCREEN_TUTORIAL_FRAME:
          sendResponse({ ok: true, ...enqueueFrame(message) });
          break;
        case MESSAGE_TYPES.OFFSCREEN_STOP_TUTORIAL_RECORDING:
          sendResponse({ ok: true, ...stopRecording(message) });
          break;
        case MESSAGE_TYPES.OFFSCREEN_REVOKE_RECORDING_URL:
          if (message.blobUrl) {
            setTimeout(() => URL.revokeObjectURL(message.blobUrl), 30000);
          }
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown offscreen recorder message." });
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();

  return true;
});
