function incompleteSubtasks(task) {
  return (task.subtasks || []).filter((item) => !item.completed);
}

function renderSubtasks(task) {
  const subtasks = task.subtasks || [];
  if (!subtasks.length) return "- No subtasks provided.";
  return subtasks
    .map((item) => `${item.completed ? "[x]" : "[ ]"} ${item.title}`)
    .join("\n");
}

function renderList(items, fallback = "- None specified.") {
  if (!Array.isArray(items) || !items.length) return fallback;
  return items.map((item) => `- ${item}`).join("\n");
}

function isAutonomousAudit(task) {
  return Boolean(task.audit_target?.url && String(task.audit_mode || "").toLowerCase().includes("read"));
}

function isTutorialTask(task) {
  return Boolean(task?.tutorial?.enabled);
}

function renderAuditContext(task) {
  if (!task.audit_mode && !task.audit_target && !task.audit_focus?.length) return "";

  const readOnly = String(task.audit_mode || "").toLowerCase().includes("read");
  const tutorial = isTutorialTask(task);
  const automation = isAutonomousAudit(task)
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
${tutorial ? `BROWSER_ACTION: {"type":"upload_sample_csv","selector":"input[type='file']"}\nThe upload_sample_csv action is tutorial-only and uses generated dummy contacts, never real customer data.` : ""}

SCREENSHOT AWARENESS:
- Treat the attached screenshot as the primary description of the current browser environment.
- Visually inspect the screenshot before choosing the next action.
- Use the structured page text and detected elements as supporting evidence, not as a substitute for looking at the screenshot.
- When a visible control is clear in the screenshot but text/selector matching is unreliable, use click_point.
- click_point coordinates are normalized to the visible viewport: xPct=0 is the left edge, xPct=1 is the right edge, yPct=0 is the top edge, yPct=1 is the bottom edge.
- The extension verifies the actual DOM control under a click_point and refuses hidden, disabled, non-interactive, or obvious state-changing targets.

Do not request typing, form submission, payment, saving, deletion, creation, activation/deactivation, approval/rejection, booking, favoriting, inviting, email sending, password reset, refunding, or any other state-changing action. The extension also blocks obvious state-changing controls.

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
${tutorial ? "TUTORIAL, READ-ONLY. Demonstrate the process clearly without committing irreversible actions or changing real customer data." : (readOnly ? "READ-ONLY. Do not make, submit, save, delete, publish, configure, or otherwise execute changes in the audited application. Recommendations are allowed; implementation is not." : task.audit_mode || "Audit only.")}

${tutorial ? `TUTORIAL GUIDANCE:\n- Work in small visible steps suitable for a screen recording.\n- Prefer clicking visible labels over direct URL jumps when that teaches the viewer where controls are.\n- Pause on important screens before moving on.\n- Do not race through multiple conceptual steps.\n- Stop before the final submit/import/send/save action unless the task explicitly authorizes it.\n- The visible pointer and tutorial captions are part of the recording.` : ""}

Audit target:
${task.audit_target?.url || "Not specified"}

Audit focus:
${renderList(task.audit_focus)}

Required deliverables:
${renderList(task.deliverables)}

Additional instructions:
${renderList(task.instructions)}

Base findings only on evidence you can actually inspect and on clearly stated task context. Do not invent screens, states, permissions, bugs, or behavior you have not observed.${automation}`;
}

function renderFooter(task) {
  if (isAutonomousAudit(task)) {
    return `At the very end of your response, include exactly these three machine-readable lines:
BROWSER_ACTION: <one JSON object, or null when complete/blocked>
AGENT_STATUS: CONTINUE | COMPLETE | BLOCKED
NEXT_ACTION: <short description of what you are doing next or the blocker>

Choose only one AGENT_STATUS value.`;
  }

  return `At the very end of your response, include exactly these two machine-readable lines:
AGENT_STATUS: CONTINUE | COMPLETE | BLOCKED
NEXT_ACTION: <short next action or blocker>

Choose only one AGENT_STATUS value.`;
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
  return `Continue working on: ${task.title}.

This is continuation ${continuationNumber}. Review what has already been completed in this conversation, then proceed with the next incomplete item. Do not repeat completed work. If execution is possible, do it now.${renderAuditContext(task)}

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

function parseBrowserAction(value) {
  const match = value.match(/(?:^|\n)BROWSER_ACTION:\s*(.+?)\s*(?:\n|$)/i);
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

export function parseAgentDirective(text) {
  const value = String(text || "");
  const statusMatch = value.match(/(?:^|\n)AGENT_STATUS:\s*(CONTINUE|COMPLETE|BLOCKED)\s*(?:\n|$)/i);
  const nextMatch = value.match(/(?:^|\n)NEXT_ACTION:\s*(.+?)\s*(?:\n|$)/i);
  return {
    status: statusMatch ? statusMatch[1].toUpperCase() : null,
    nextAction: nextMatch ? nextMatch[1].trim() : "",
    browserAction: parseBrowserAction(value)
  };
}
