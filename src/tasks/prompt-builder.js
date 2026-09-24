function incompleteSubtasks(task) {
  return (task.subtasks || []).filter((item) => !item.completed);
}

function renderSubtasks(task) {
  const subtasks = task.subtasks || [];
  if (!subtasks.length) return "- No subtasks provided.";
  return subtasks
    .map((item) => `${item.completed ? "[x]" : "[ ]"} ${item.title}${item.id ? ` (ID: ${item.id})` : ""}`)
    .join("\n");
}

function renderList(items, fallback = "- None specified.") {
  if (!Array.isArray(items) || !items.length) return fallback;
  return items.map((item) => `- ${item}`).join("\n");
}

function isTutorialTask(task) {
  return Boolean(task?.tutorial?.enabled);
}

function renderAuditContext(task) {
  if (!task.audit_mode && !task.audit_target && !task.browser_target && !task.audit_focus?.length) return "";

  const readOnly = isReadOnlyBrowserTask(task);
  const interactive = isInteractiveBrowserTask(task);
  const tutorial = isTutorialTask(task);
  const automation = isAutonomousBrowserTask(task)
    ? `

BROWSER AUTOMATION:
You have a browser operator controlling the ${tutorial ? "tutorial target" : "audit target"} for you. The extension will provide a screenshot plus a structured page observation after each browser action.

You may request exactly ONE browser action per response using one JSON object on one line:
BROWSER_ACTION: {"type":"inspect"}
BROWSER_ACTION: {"type":"click_text","text":"Locations"}
BROWSER_ACTION: {"type":"click_selector","selector":"a[href='/locations/']"}
BROWSER_ACTION: {"type":"click_point","xPct":0.22,"yPct":0.41}
BROWSER_ACTION: {"type":"navigate","url":"/locations/"}
BROWSER_ACTION: {"type":"scroll","deltaY":800}
BROWSER_ACTION: {"type":"back"}
BROWSER_ACTION: {"type":"wait","ms":1000}
${interactive ? `BROWSER_ACTION: {"type":"type_text","text":"Exact text to type"}
BROWSER_ACTION: {"type":"press_key","key":"Enter"}` : ""}
${tutorial ? `BROWSER_ACTION: {"type":"upload_sample_csv","selector":"input[type='file']"}\nThe upload_sample_csv action is tutorial-only and uses generated dummy contacts, never real customer data.` : ""}

SCREENSHOT AWARENESS:
- Treat the attached screenshot as the primary description of the current browser environment.
- Visually inspect the screenshot before choosing the next action.
- Use the structured page text and detected elements as supporting evidence, not as a substitute for looking at the screenshot.
- When a visible control is clear in the screenshot but text/selector matching is unreliable, use click_point.
- click_point coordinates are normalized to the visible viewport: xPct=0 is the left edge, xPct=1 is the right edge, yPct=0 is the top edge, yPct=1 is the bottom edge.
- The extension verifies the actual DOM control under a click_point and refuses hidden, disabled, or non-interactive targets.${readOnly ? " It also refuses obvious state-changing targets." : ""}

${readOnly ? "Do not request typing, form submission, payment, saving, deletion, creation, activation/deactivation, approval/rejection, booking, favoriting, inviting, email sending, password reset, refunding, or any other state-changing action. The extension also blocks obvious state-changing controls." : "This is an explicitly authorized interactive browser task. Perform only the state-changing actions stated in the task. Type text exactly as supplied, never infer additional recipients or content, and visually verify the result before reporting completion."}

Use the browser yourself. Do not ask the user to manually navigate or capture screenshots unless authentication, CAPTCHA, an external origin, or another genuinely human-only blocker prevents progress.

For a normal browser step, use:
AGENT_STATUS: CONTINUE

When the audit scope is genuinely complete, use:
BROWSER_ACTION: null
AGENT_STATUS: COMPLETE

If the extension reports a blocked/failed browser action, choose a different safe route if possible. Use BLOCKED only for a true human-only blocker.`
    : "";

  return `

MODE:
${tutorial ? "TUTORIAL, READ-ONLY. Demonstrate the process clearly without committing irreversible actions or changing real customer data." : (readOnly ? "READ-ONLY. Do not make, submit, save, delete, publish, configure, or otherwise execute changes in the audited application. Recommendations are allowed; implementation is not." : (interactive ? "INTERACTIVE BROWSER AUTOMATION. Execute only the actions explicitly authorized by this task." : task.audit_mode || "Audit only."))}

${tutorial ? `TUTORIAL GUIDANCE:\n- Work in small visible steps suitable for an OBS screen recording.\n- Prefer clicking visible labels over direct URL jumps when that teaches the viewer where controls are.\n- Pause on important screens before moving on.\n- Do not race through multiple conceptual steps.\n- Stop before the final submit/import/send/save action unless the task explicitly authorizes it.\n- The extension handles navigation, the visible pointer, screenshots, and tutorial captions only. Recording is external.` : ""}

Audit target:
${browserTargetUrl(task) || "Not specified"}

Audit focus:
${renderList(task.audit_focus)}

Required deliverables:
${renderList(task.deliverables)}

Additional instructions:
${renderList(task.instructions)}

Base findings only on evidence you can actually inspect and on clearly stated task context. Do not invent screens, states, permissions, bugs, or behavior you have not observed.${automation}`;
}

function renderFooter(task) {
  const completedSubtasksLine = (task.subtasks || []).length
    ? "\nCOMPLETED_SUBTASKS: <JSON array of subtask IDs completed so far, or []>"
    : "";

  if (isAutonomousBrowserTask(task)) {
    return `At the very end of your response, include these machine-readable lines:
BROWSER_ACTION: <one JSON object, or null when complete/blocked>
AGENT_STATUS: CONTINUE | COMPLETE | BLOCKED
NEXT_ACTION: <short description of what you are doing next or the blocker>${completedSubtasksLine}

Choose only one AGENT_STATUS value. Only report a subtask as completed after all of its work and validation are finished. Keep previously completed subtask IDs in the array.`;
  }

  return `At the very end of your response, include these machine-readable lines:
AGENT_STATUS: CONTINUE | COMPLETE | BLOCKED
NEXT_ACTION: <short next action or blocker>${completedSubtasksLine}

Choose only one AGENT_STATUS value. Only report a subtask as completed after all of its work and validation are finished. Keep previously completed subtask IDs in the array.`;
}

export function buildInitialPrompt(task) {
  const next = task.next_action || incompleteSubtasks(task)[0]?.title || "Work on the task and make concrete progress.";
  return `Continue helping me with this task. Treat the task details below as the source of truth for this work.

Project: ${task.project || "Unspecified"}
Task: ${task.title}
Priority: ${task.priority || "P3 - Normal"}
Status: ${task.status || "Now"}
Owner: ${task.owner || "Unspecified"}
Waiting on: ${task.waiting_on || "Nobody"}${renderAuditContext(task)}

Next action:
${next}

Subtasks:
${renderSubtasks(task)}

Work on the next incomplete item. Use the context already available in this conversation. Do not repeat completed work. Make a best effort to execute the work rather than only describing it.

${renderFooter(task)}`;
}

export function buildContinuationPrompt(task, continuationNumber = 1) {
  const next = task.next_action || incompleteSubtasks(task)[0]?.title || "Proceed with the next incomplete item.";
  return `Continue working on: ${task.title}.

This is continuation ${continuationNumber}. Review what has already been completed in this conversation, then proceed with the next incomplete item. Do not repeat completed work. If execution is possible, do it now.${renderAuditContext(task)}

Next action from the previous response:
${next}

Subtasks:
${renderSubtasks(task)}

${renderFooter(task)}`;
}

function renderInteractiveElements(elements) {
  if (!Array.isArray(elements) || !elements.length) return "- None detected.";
  return elements.slice(0, 120).map((item) => {
    const parts = [
      `#${item.index}`,
      item.tag,
      item.text ? `"${String(item.text).slice(0, 180)}"` : "",
      item.role ? `role=${item.role}` : "",
      item.href ? `href=${item.href}` : "",
      item.center ? `center=(${item.center.xPct},${item.center.yPct})` : "",
      item.disabled ? "disabled" : ""
    ].filter(Boolean);
    return `- ${parts.join(" | ")}`;
  }).join("\n");
}

export function buildBrowserObservationPrompt(task, observation, stepNumber = 1, actionResult = null) {
  const snapshot = observation?.snapshot || {};
  return `Browser observation ${stepNumber} for ${task.title}.

A screenshot of the current browser viewport is attached. Inspect it first; it is your primary environment view.

Current page:
URL: ${snapshot.url || "unknown"}
Title: ${snapshot.title || "unknown"}
Viewport: ${JSON.stringify(snapshot.viewport || {})}

Visible/page text:
${String(snapshot.text || "").slice(0, 14000)}

Detected interactive elements:
${renderInteractiveElements(snapshot.interactiveElements)}

Previous browser action result:
${actionResult ? JSON.stringify(actionResult) : "Initial observation; no browser action has run yet."}

${isTutorialTask(task) ? "Continue the tutorial using the browser yourself. Visually inspect the screenshot, choose the next small visible teaching step, and request exactly one safe browser action. Prefer click_point when the screenshot is clearer than the DOM labels. Do not ask the user to move around the site for you." : "Continue the audit using the browser yourself. Visually inspect the screenshot first, then use page text/elements to confirm what you see and choose exactly one safe next browser action. Prefer click_point when visual placement is clearer than the DOM labels. Do not ask the user to move around the site for you."}

${renderFooter(task)}`;
}

function lastDirectiveMatch(value, pattern) {
  const matches = Array.from(value.matchAll(pattern));
  return matches.length ? matches[matches.length - 1] : null;
}

function parseBrowserAction(value) {
  const match = lastDirectiveMatch(
    value,
    /^[ \t]*(?:[-*]\s*)?BROWSER_ACTION:\s*(.+?)\s*$/gim
  );
  if (!match) return undefined;
  const raw = match[1].trim();
  if (/^null$/i.test(raw)) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseCompletedSubtaskIds(value) {
  const match = lastDirectiveMatch(
    value,
    /^[ \t]*(?:[-*]\s*)?COMPLETED_SUBTASKS:\s*(.+?)\s*$/gim
  );
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed
      .filter((item) => typeof item === "string" || typeof item === "number")
      .map((item) => String(item).trim())
      .filter(Boolean))];
  } catch {
    return [];
  }
}

export function parseAgentDirective(text) {
  const value = String(text || "");
  const statusMatch = lastDirectiveMatch(
    value,
    /^[ \t]*(?:[-*]\s*)?AGENT_STATUS:\s*(CONTINUE|COMPLETE|BLOCKED)\s*$/gim
  );
  const nextMatch = lastDirectiveMatch(
    value,
    /^[ \t]*(?:[-*]\s*)?NEXT_ACTION:\s*(.*?)\s*$/gim
  );
  return {
    status: statusMatch ? statusMatch[1].toUpperCase() : null,
    nextAction: nextMatch ? nextMatch[1].trim() : "",
    browserAction: parseBrowserAction(value),
    completedSubtaskIds: parseCompletedSubtaskIds(value)
  };
}
import {
  browserTargetUrl,
  isAutonomousBrowserTask,
  isInteractiveBrowserTask,
  isReadOnlyBrowserTask
} from "./browser-task.js";
