export function completeSubtasks(subtasks, completedIdentifiers, completedAt = new Date().toISOString()) {
  const identifiers = new Set((completedIdentifiers || [])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean));

  let changed = false;
  const nextSubtasks = (subtasks || []).map((subtask) => {
    const matches = identifiers.has(String(subtask.id || "").trim().toLowerCase()) ||
      identifiers.has(String(subtask.title || "").trim().toLowerCase());
    if (!matches || subtask.completed) return subtask;

    changed = true;
    return { ...subtask, completed: true, completedAt };
  });

  return { subtasks: nextSubtasks, changed };
}
