import { MESSAGE_TYPES } from "../shared/constants.js";

let mediaRecorder = null;
let capturedStream = null;
let playbackContext = null;
let chunks = [];
let activeRecording = null;

function preferredMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((value) => MediaRecorder.isTypeSupported(value)) || "";
}

async function mirrorCapturedAudio(stream) {
  if (!stream.getAudioTracks().length) return;
  playbackContext = new AudioContext();
  const source = playbackContext.createMediaStreamSource(stream);
  source.connect(playbackContext.destination);
}

function cleanupStream() {
  try {
    capturedStream?.getTracks().forEach((track) => track.stop());
  } catch {
    // Stream may already be closed by Chrome.
  }
  capturedStream = null;

  if (playbackContext) {
    playbackContext.close().catch(() => {});
    playbackContext = null;
  }
}

async function startRecording(message) {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    throw new Error("A tutorial recording is already running.");
  }

  const streamId = String(message.streamId || "");
  if (!streamId) throw new Error("Missing tab capture stream ID.");

  const includeAudio = message.includeAudio !== false;
  const videoConstraints = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: streamId
    }
  };
  const audioConstraints = includeAudio
    ? {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      }
    : false;

  capturedStream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: audioConstraints
  });

  if (includeAudio) await mirrorCapturedAudio(capturedStream);

  const mimeType = preferredMimeType();
  chunks = [];
  activeRecording = {
    recordingId: message.recordingId,
    taskId: message.taskId,
    filename: message.filename,
    startedAt: Date.now()
  };

  mediaRecorder = mimeType
    ? new MediaRecorder(capturedStream, {
        mimeType,
        videoBitsPerSecond: 4_500_000
      })
    : new MediaRecorder(capturedStream, {
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
        durationMs: Math.max(0, Date.now() - Number(recording?.startedAt || Date.now()))
      });
    } finally {
      cleanupStream();
      mediaRecorder = null;
      chunks = [];
      activeRecording = null;
    }
  };

  capturedStream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch {
        // Chrome may already be stopping the recorder.
      }
    }
  });

  mediaRecorder.start(1000);
  return { recording: true, mimeType: mediaRecorder.mimeType || mimeType || "video/webm" };
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
