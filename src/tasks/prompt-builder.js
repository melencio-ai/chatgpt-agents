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

export function buildInitialPrompt(task) {
  const next = task.next_action || incompleteSubtasks(task)[0]?.title || "Work on the task and make concrete progress.";
  return `Continue helping me with this task. Treat the task details below as the source of truth for this work.\n\nProject: ${task.project || "Unspecified"}\nTask: ${task.title}\nPriority: ${task.priority || "P3 - Normal"}\nStatus: ${task.status || "Now"}\nOwner: ${task.owner || "Unspecified"}\nWaiting on: ${task.waiting_on || "Nobody"}\n\nNext action:\n${next}\n\nSubtasks:\n${renderSubtasks(task)}\n\nWork on the next incomplete item. Use the context already available in this conversation. Do not repeat completed work. Make a best effort to execute the work rather than only describing it.\n\nAt the very end of your response, include exactly these two machine-readable lines:\nAGENT_STATUS: CONTINUE | COMPLETE | BLOCKED\nNEXT_ACTION: <short next action or blocker>\n\nChoose only one AGENT_STATUS value.`;
}

export function buildContinuationPrompt(task, continuationNumber = 1) {
  return `Continue working on: ${task.title}.\n\nThis is continuation ${continuationNumber}. Review what has already been completed in this conversation, then proceed with the next incomplete item. Do not repeat completed work. If execution is possible, do it now.\n\nAt the very end of your response, include exactly these two machine-readable lines:\nAGENT_STATUS: CONTINUE | COMPLETE | BLOCKED\nNEXT_ACTION: <short next action or blocker>\n\nChoose only one AGENT_STATUS value.`;
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
