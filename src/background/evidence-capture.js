import {
  getTask,
  getAgentByTaskId,
  updateState
} from "../storage/repository.js";
import { MESSAGE_TYPES } from "../shared/constants.js";

function nowIso() {
  return new Date().toISOString();
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return chrome.tabs.get(tabId);
}

async function findTargetTab(targetUrl) {
  const tabs = await chrome.tabs.query({});
  const matches = tabs.filter((tab) => {
    const current = safeUrl(tab.url);
    return current && current.origin === targetUrl.origin;
  });

  return matches.find((tab) => tab.active) ||
    matches.find((tab) => tab.status === "complete") ||
    matches[0] ||
    null;
}

async function ensureTargetTab(targetUrl) {
  const existing = await findTargetTab(targetUrl);
  if (existing) return existing;

  const created = await chrome.tabs.create({
    url: targetUrl.href,
    active: true
  });
  const loaded = await waitForTabComplete(created.id);
  const finalUrl = safeUrl(loaded.url);

  if (!finalUrl || finalUrl.origin !== targetUrl.origin) {
    throw new Error(
      "Dynk opened in a new tab but redirected away from the audit target. Finish login/navigation, then click Capture evidence again."
    );
  }
  return loaded;
}

async function captureScreenshot(tabId) {
  const debuggee = { tabId };
  let attached = false;

  try {
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(debuggee, "Page.enable");

    const result = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 82,
      fromSurface: true,
      captureBeyondViewport: true,
      optimizeForSpeed: true
    });

    if (!result?.data) {
      throw new Error("Chrome debugger returned an empty screenshot.");
    }

    return result.data;
  } catch (error) {
    const message = String(error?.message || error);
    if (/another debugger|already attached|devtools/i.test(message)) {
      throw new Error("Cannot capture while another debugger/DevTools session controls this tab. Close DevTools for the Dynk tab and try again.");
    }
    if (/restricted by policy/i.test(message)) {
      throw new Error(`Browser policy blocked debugger screenshot capture: ${message}`);
    }
    throw error;
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch {
        // Target may have closed while capturing.
      }
    }
  }
}

export async function captureTaskEvidence(taskId) {
  const task = await getTask(taskId);
  if (!task) throw new Error("Task not found.");

  const target = safeUrl(task.audit_target?.url);
  if (!target) throw new Error("This task has no valid audit_target.url.");

  const agent = await getAgentByTaskId(taskId);
  if (!agent?.tabId) {
    throw new Error("Start this audit agent first so there is a ChatGPT conversation to receive the screenshot.");
  }

  try {
    await chrome.tabs.get(agent.tabId);
  } catch {
    throw new Error("The ChatGPT tab for this audit agent is no longer open.");
  }

  const targetTab = await ensureTargetTab(target);
  const finalTarget = safeUrl(targetTab.url);
  if (!finalTarget || finalTarget.origin !== target.origin) {
    throw new Error("Navigate the Dynk tab back to the audit target, then capture again.");
  }

  const base64 = await captureScreenshot(targetTab.id);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `audit-${task.id}-${timestamp}.jpg`;

  const response = await chrome.tabs.sendMessage(agent.tabId, {
    type: MESSAGE_TYPES.ATTACH_IMAGE,
    base64,
    mimeType: "image/jpeg",
    filename,
    sourceUrl: targetTab.url || target.href
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Screenshot captured, but ChatGPT did not accept the attachment.");
  }

  await updateState((state) => {
    const current = state.agents[agent.id];
    if (!current) return;
    state.agents[agent.id] = {
      ...current,
      evidenceCount: (current.evidenceCount || 0) + 1,
      lastEvidence: {
        sourceUrl: targetTab.url || target.href,
        filename,
        capturedAt: nowIso(),
        attachMethod: response.method || "file-input"
      },
      updatedAt: nowIso()
    };
  });

  return {
    taskId,
    sourceUrl: targetTab.url || target.href,
    filename,
    attachMethod: response.method || "file-input"
  };
}
