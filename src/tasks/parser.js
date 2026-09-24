function slugify(value) {
  return String(value || "task")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || "task";
}

function stableTaskId(raw, index = 0) {
  if (raw?.id) return String(raw.id);
  if (raw?.source_transcript_id !== undefined && raw?.source_transcript_id !== null) {
    return `task-transcript-${raw.source_transcript_id}`;
  }
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `task-${slugify(raw?.title)}${suffix}`;
}

function normalizeSubtask(raw, parentId, index) {
  if (typeof raw === "string") {
    return {
      id: `${parentId}-subtask-${index + 1}`,
      title: raw.trim(),
      completed: false
    };
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid subtask at index ${index}.`);
  }
  const title = String(raw.title || "").trim();
  if (!title) throw new Error(`Subtask ${index + 1} is missing a title.`);
  return {
    ...raw,
    id: String(raw.id || `${parentId}-subtask-${index + 1}`),
    title,
    completed: Boolean(raw.completed)
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return [String(value).trim()].filter(Boolean);
}

function normalizeAuditTarget(raw, projectDefaults) {
  const target = raw.audit_target ?? projectDefaults.audit_target;
  if (!target) return null;
  if (typeof target === "string") return { url: target };
  if (typeof target !== "object" || Array.isArray(target)) {
    throw new Error("audit_target must be a URL string or object.");
  }
  return {
    ...target,
    url: String(target.url || "").trim()
  };
}

function explicitBrowserAutomation(raw, projectDefaults) {
  const text = [
    raw.task_mode,
    raw.mode,
    raw.browser_mode,
    projectDefaults.task_mode,
    projectDefaults.mode,
    projectDefaults.browser_mode,
    raw.title,
    raw.next_action
  ].map((value) => String(value || "")).join(" ");
  return /\bbrowser[ _-]+automation\b/i.test(text);
}

function firstTaskUrl(raw) {
  const values = [
    raw.next_action,
    ...(Array.isArray(raw.subtasks) ? raw.subtasks.flatMap((item) => [
      typeof item === "string" ? item : item?.title,
      ...(Array.isArray(item?.instructions) ? item.instructions : [])
    ]) : [])
  ];
  for (const value of values) {
    const match = String(value || "").match(/https?:\/\/[^\s<>"']+/i);
    if (match) return match[0].replace(/[),.;]+$/, "");
  }
  return "";
}

function normalizeBrowserTarget(raw, projectDefaults, automationDeclared) {
  const target = raw.browser_target ?? projectDefaults.browser_target;
  if (target) {
    if (typeof target === "string") return { url: target.trim() };
    if (typeof target !== "object" || Array.isArray(target)) {
      throw new Error("browser_target must be a URL string or object.");
    }
    return { ...target, url: String(target.url || "").trim() };
  }
  const inferredUrl = automationDeclared ? firstTaskUrl(raw) : "";
  return inferredUrl ? { url: inferredUrl } : null;
}

function normalizeTutorial(raw, projectDefaults) {
  const mode = String(raw.task_mode || raw.mode || projectDefaults.task_mode || projectDefaults.mode || "").trim().toLowerCase();
  const value = raw.tutorial ?? projectDefaults.tutorial;

  if (!value && mode !== "tutorial") return null;

  if (value === true || value === undefined || value === null) {
    return {
      enabled: true,
      title: String(raw.title || "Tutorial").trim(),
      pace: "guided"
    };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tutorial must be true or an object.");
  }

  return {
    enabled: value.enabled !== false,
    title: String(value.title || raw.title || "Tutorial").trim(),
    pace: String(value.pace || "guided").trim().toLowerCase()
  };
}

function normalizeTask(raw, index = 0, projectDefaults = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Task ${index + 1} must be an object.`);
  }
  const title = String(raw.title || "").trim();
  if (!title) throw new Error(`Task ${index + 1} is missing a title.`);

  const id = stableTaskId(raw, index);
  const automationDeclared = explicitBrowserAutomation(raw, projectDefaults);
  const subtasks = Array.isArray(raw.subtasks)
    ? raw.subtasks.map((item, subIndex) => normalizeSubtask(item, id, subIndex))
    : [];

  const source = raw.source && typeof raw.source === "object"
    ? { ...raw.source }
    : {
        transcript_id: raw.source_transcript_id ?? null,
        started_at: raw.source_started_at ?? null,
        ended_at: raw.source_ended_at ?? null,
        offset_seconds: raw.source_offset_seconds ?? null,
        end_offset_seconds: raw.source_end_offset_seconds ?? null,
        speaker: raw.source_speaker ?? null,
        excerpt: raw.source_excerpt ?? null
      };

  return {
    id,
    title,
    project: raw.project || projectDefaults.title || "",
    owner: raw.owner || projectDefaults.owner || "",
    due_date: raw.due_date ?? null,
    priority: raw.priority || "P3 - Normal",
    status: raw.status || "Now",
    archived_at: raw.archived_at ?? null,
    next_action: raw.next_action || "",
    waiting_on: raw.waiting_on || "",
    chatgpt_url: raw.chatgpt_url || "",
    confidence: raw.confidence ?? null,
    rationale: raw.rationale || "",
    task_mode: raw.task_mode || raw.mode || projectDefaults.task_mode || projectDefaults.mode || (automationDeclared ? "browser_automation" : ""),
    browser_mode: raw.browser_mode || projectDefaults.browser_mode || (automationDeclared ? "interactive" : ""),
    browser_target: normalizeBrowserTarget(raw, projectDefaults, automationDeclared),
    tutorial: normalizeTutorial(raw, projectDefaults),
    audit_mode: raw.audit_mode || projectDefaults.audit_mode || "",
    audit_target: normalizeAuditTarget(raw, projectDefaults),
    audit_focus: normalizeStringList(raw.audit_focus ?? projectDefaults.audit_focus),
    deliverables: normalizeStringList(raw.deliverables ?? projectDefaults.deliverables),
    instructions: normalizeStringList(raw.instructions ?? projectDefaults.instructions),
    subtasks,
    source
  };
}

export function parseTaskPayload(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;

  let rawTasks;
  let projectDefaults = {};

  if (Array.isArray(data)) {
    rawTasks = data;
  } else if (data && typeof data === "object" && Array.isArray(data.tasks)) {
    rawTasks = data.tasks;
    projectDefaults = data.project && typeof data.project === "object" ? data.project : {};
  } else if (data && typeof data === "object") {
    rawTasks = [data];
  } else {
    throw new Error("JSON must contain a task object, an array of tasks, or an object with a tasks array.");
  }

  if (!rawTasks.length) throw new Error("The JSON file contains no tasks.");

  const seen = new Set();
  return rawTasks.map((raw, index) => {
    const task = normalizeTask(raw, index, projectDefaults);
    let id = task.id;
    let counter = 2;
    while (seen.has(id)) {
      id = `${task.id}-${counter++}`;
    }
    seen.add(id);
    if (id !== task.id) {
      task.id = id;
      task.subtasks = task.subtasks.map((subtask, subIndex) => ({
        ...subtask,
        id: `${id}-subtask-${subIndex + 1}`
      }));
    }
    return task;
  });
}
