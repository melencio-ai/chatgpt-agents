import { MESSAGE_TYPES } from "../shared/constants.js";
import {
  getState,
  initializeState,
  setSettings,
  upsertTasks
} from "../storage/repository.js";
import { parseTaskPayload } from "../tasks/parser.js";
import { captureTaskEvidence } from "./evidence-capture.js";
import { setVisualMouseVisibility } from "./browser-operator.js";
import {
  startTask,
  continueTask,
  pauseTask,
  cancelTask,
  deleteTask,
  openTaskTab,
  pauseAll,
  resumeAll,
  handlePageReady,
  handleResponse,
  markGenerating,
  handleTabRemoved,
  pumpQueue
} from "./task-runner.js";

chrome.runtime.onInstalled.addListener(async () => {
  await initializeState();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(async () => {
  await initializeState();
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
          sendResponse({ ok: true, state: await getState() });
          break;
        case MESSAGE_TYPES.IMPORT_TASK_PAYLOAD: {
          const tasks = parseTaskPayload(message.payload);
          const state = await upsertTasks(tasks);
          sendResponse({ ok: true, imported: tasks.length, state });
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
          sendResponse({ ok: true, state });
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
