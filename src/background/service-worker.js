import { MESSAGE_TYPES } from "../shared/constants.js";
import {
  getState,
  initializeState,
  setSettings,
  upsertTasks,
  recordDetectedTaskPayload
} from "../storage/repository.js";
import { parseTaskPayload } from "../tasks/parser.js";
import {
  fingerprintTaskPayload,
  parseDetectedTaskPayload
} from "../tasks/detected-task-json.js";
import { captureTaskEvidence } from "./evidence-capture.js";
import { setVisualMouseVisibility } from "./browser-operator.js";
import {
  startTask,
  continueTask,
  pauseTask,
  cancelTask,
  deleteTask,
  openTaskTab,
  openBrowserTab,
  pauseAll,
  resumeAll,
  handlePageReady,
  handleResponse,
  markGenerating,
  handleChatError,
  handleTabRemoved,
  enforceAgentLimit,
  pumpQueue
} from "./task-runner.js";

// Runs whenever the service worker loads, including a manual extension reload.
// This prevents runs saved under an older multi-agent build from all resuming.
const startupSafety = initializeState()
  .then(() => enforceAgentLimit())
  .catch((error) => console.error("Could not enforce the single-agent safety limit.", error));

async function ensureChatContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.GET_CHAT_STATE
    });
    if (response?.ok) return true;
  } catch {
    // The tab may still have a content script from a previous extension instance.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/chatgpt-content.js"]
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 200 : 250));
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: MESSAGE_TYPES.GET_CHAT_STATE
        });
        if (response?.ok) return true;
      } catch {
        // Give the reinjected content script time to initialize.
      }
    }

    return false;
  } catch {
    return false;
  }
}

async function rehydrateChatTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  } catch {
    return;
  }

  for (const tab of tabs) {
    if (!tab.id) continue;
    if (!(await ensureChatContentScript(tab.id))) continue;
    await handlePageReady(tab.id, tab.url || "");
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await startupSafety;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await rehydrateChatTabs();
  await pumpQueue();
});

chrome.runtime.onStartup.addListener(async () => {
  await startupSafety;
  await rehydrateChatTabs();
  await pumpQueue();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case MESSAGE_TYPES.GET_STATE:
          await rehydrateChatTabs();
          sendResponse({ ok: true, state: await getState() });
          break;
        case MESSAGE_TYPES.IMPORT_TASK_PAYLOAD: {
          const tasks = parseTaskPayload(message.payload);
          const state = await upsertTasks(tasks);
          sendResponse({ ok: true, imported: tasks.length, state });
          break;
        }
        case MESSAGE_TYPES.TASK_JSON_CANDIDATES: {
          const current = await getState();
          if (current.settings?.autoDetectTaskJson === false) {
            sendResponse({ ok: true, detected: 0, imported: 0, ignored: true });
            break;
          }

          const candidates = Array.isArray(message.candidates)
            ? message.candidates.slice(0, 12)
            : [];

          let detected = 0;
          let imported = 0;
          let skippedExisting = 0;
          let duplicates = 0;
          let latestState = current;
          let firstImportedTaskId = "";

          for (const candidate of candidates) {
            if (typeof candidate !== "string" || candidate.length > 300000) continue;

            try {
              const { tasks } = parseDetectedTaskPayload(candidate);
              const fingerprint = fingerprintTaskPayload(candidate);
              const existingDetection = latestState.detectedTaskPayloads?.[fingerprint];
              const autoImport = current.settings?.autoImportDetectedTasks !== false;

              if (existingDetection?.importedAt || (existingDetection && !autoImport)) {
                duplicates += 1;
                continue;
              }

              const result = await recordDetectedTaskPayload({
                fingerprint,
                tasks,
                sourceUrl: message.url || sender.tab?.url || "",
                autoImport
              });

              latestState = result.state;
              if (result.duplicate) {
                duplicates += 1;
                continue;
              }

              detected += tasks.length;
              imported += result.importedTaskIds.length;
              skippedExisting += result.skippedExisting;
              if (!firstImportedTaskId && result.importedTaskIds.length) {
                firstImportedTaskId = result.importedTaskIds[0];
              }
            } catch {
              // Ignore valid JSON that does not match the task schema.
            }
          }

          let autoStarted = false;
          if (
            firstImportedTaskId &&
            latestState.settings?.autoStartDetectedTasks === true
          ) {
            try {
              await startTask(firstImportedTaskId, "auto", false);
              autoStarted = true;
            } catch (error) {
              console.warn("Detected task was imported but could not auto-start.", error);
            }
          }

          sendResponse({
            ok: true,
            detected,
            imported,
            skippedExisting,
            duplicates,
            autoStarted,
            state: await getState()
          });
          break;
        }
        case MESSAGE_TYPES.START_TASK:
          sendResponse({
            ok: true,
            agent: await startTask(message.taskId, message.mode, Boolean(message.forceRestart))
          });
          break;
        case MESSAGE_TYPES.CONTINUE_TASK:
          sendResponse({ ok: true, agent: await continueTask(message.taskId) });
          break;
        case MESSAGE_TYPES.PAUSE_TASK:
          sendResponse({ ok: true, agent: await pauseTask(message.taskId) });
          break;
        case MESSAGE_TYPES.CANCEL_TASK:
          sendResponse({ ok: true, agent: await cancelTask(message.taskId) });
          break;
        case MESSAGE_TYPES.DELETE_TASK:
          sendResponse({ ok: true, deleted: await deleteTask(message.taskId) });
          break;
        case MESSAGE_TYPES.OPEN_TASK_TAB:
          sendResponse({ ok: true, agent: await openTaskTab(message.taskId) });
          break;
        case MESSAGE_TYPES.OPEN_BROWSER_TAB:
          sendResponse({ ok: true, agent: await openBrowserTab(message.taskId) });
          break;
        case MESSAGE_TYPES.CAPTURE_TASK_EVIDENCE:
          sendResponse({ ok: true, evidence: await captureTaskEvidence(message.taskId) });
          break;
        case MESSAGE_TYPES.UPDATE_SETTINGS: {
          const state = await setSettings(message.patch || {});
          if (Object.prototype.hasOwnProperty.call(message.patch || {}, "visualMouse")) {
            const visible = state.settings.visualMouse !== false;
            for (const agent of Object.values(state.agents || {})) {
              if (!agent.auditTabId) continue;
              try {
                await setVisualMouseVisibility(agent.auditTabId, visible, "Agent");
              } catch {
                // The audited tab may have been closed or navigated away.
              }
            }
          }
          if (Object.prototype.hasOwnProperty.call(message.patch || {}, "maxConcurrentAgents")) {
            await pumpQueue();
          }
          sendResponse({ ok: true, state: await getState() });
          break;
        }
        case MESSAGE_TYPES.PAUSE_ALL:
          await pauseAll();
          sendResponse({ ok: true });
          break;
        case MESSAGE_TYPES.RESUME_ALL:
          await resumeAll();
          sendResponse({ ok: true });
          break;
        case MESSAGE_TYPES.CHATGPT_PAGE_READY:
          if (sender.tab?.id) await handlePageReady(sender.tab.id, message.url || sender.tab.url);
          sendResponse({ ok: true });
          break;
        case MESSAGE_TYPES.CHATGPT_GENERATING:
          if (sender.tab?.id) await markGenerating(sender.tab.id);
          sendResponse({ ok: true });
          break;
        case MESSAGE_TYPES.CHATGPT_ERROR:
          if (sender.tab?.id) {
            await handleChatError(sender.tab.id, message.error || "", message.url || sender.tab.url);
          }
          sendResponse({ ok: true });
          break;
        case MESSAGE_TYPES.CHATGPT_RESPONSE:
          if (sender.tab?.id) await handleResponse(sender.tab.id, message.text || "", message.url || sender.tab.url);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown message type." });
      }
    } catch (error) {
      console.error(error);
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true;
});
