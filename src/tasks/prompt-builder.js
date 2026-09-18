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

function renderAuditContext(task) {
  if (!task.audit_mode && !task.audit_target && !task.audit_focus?.length) return "";

  const readOnly = String(task.audit_mode || "").toLowerCase().includes("read");
  return `\n\nAUDIT MODE:
${readOnly ? "READ-ONLY. Do not make, submit, save, delete, publish, configure, or otherwise execute changes in the audited application. Recommendations are allowed; implementation is not." : task.audit_mode || "Audit only."}

Audit target:
${task.audit_target?.url || "Not specified"}

Audit focus:
${renderList(task.audit_focus)}

Required deliverables:
${renderList(task.deliverables)}

Additional instructions:
${renderList(task.instructions)}

Screenshot evidence may be attached to the composer by the browser extension. Base findings only on evidence you can actually inspect and on clearly stated task context. Do not invent screens, states, permissions, bugs, or behavior you have not observed. If you need another page or state to continue the audit, use AGENT_STATUS: BLOCKED and put the exact page/screen/state needed in NEXT_ACTION.`;
}

export function buildInitialPrompt(task) {
  const next = task.next_action || incompleteSubtasks(task)[0]?.title || "Work on the task and make concrete progress.";
  return `Continue helping me with this task. Treat the task details below as the source of truth for this work.\n\nProject: ${task.project || "Unspecified"}\nTask: ${task.title}\nPriority: ${task.priority || "P3 - Normal"}\nStatus: ${task.status || "Now"}\nOwner: ${task.owner || "Unspecified"}\nWaiting on: ${task.waiting_on || "Nobody"}${renderAuditContext(task)}\n\nNext action:\n${next}\n\nSubtasks:\n${renderSubtasks(task)}\n\nWork on the next incomplete item. Use the context already available in this conversation. Do not repeat completed work. Make a best effort to execute the work rather than only describing it.\n\nAt the very end of your response, include exactly these two machine-readable lines:\nAGENT_STATUS: CONTINUE | COMPLETE | BLOCKED\nNEXT_ACTION: <short next action or blocker>\n\nChoose only one AGENT_STATUS value.`;
}

export function buildContinuationPrompt(task, continuationNumber = 1) {
  return `Continue working on: ${task.title}.\n\nThis is continuation ${continuationNumber}. Review what has already been completed in this conversation, then proceed with the next incomplete item. Do not repeat completed work. If execution is possible, do it now.${renderAuditContext(task)}\n\nAt the very end of your response, include exactly these two machine-readable lines:\nAGENT_STATUS: CONTINUE | COMPLETE | BLOCKED\nNEXT_ACTION: <short next action or blocker>\n\nChoose only one AGENT_STATUS value.`;
}

export function parseAgentDirective(text) {
  const value = String(text || "");
  const statusMatch = value.match(/(?:^|\n)AGENT_STATUS:\s*(CONTINUE|COMPLETE|BLOCKED)\s*(?:\n|$)/i);
  const nextMatch = value.match(/(?:^|\n)NEXT_ACTION:\s*(.+?)\s*(?:\n|$)/i);
  return {
    status: statusMatch ? statusMatch[1].toUpperCase() : null,
    nextAction: nextMatch ? nextMatch[1].trim() : ""
  };
}
