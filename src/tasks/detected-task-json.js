import { parseTaskPayload } from "./parser.js";

const TASK_HINT_KEYS = new Set([
  "project",
  "owner",
  "priority",
  "status",
  "next_action",
  "waiting_on",
  "subtasks",
  "instructions",
  "deliverables",
  "task_mode",
  "mode",
  "audit_mode",
  "audit_target",
  "audit_focus",
  "tutorial",
  "due_date",
  "source_transcript_id"
]);

function parseJson(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function hasTaskHints(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => TASK_HINT_KEYS.has(key))
  );
}

export function looksLikeTaskPayload(value) {
  let data;
  try {
    data = parseJson(value);
  } catch {
    return false;
  }

  if (Array.isArray(data)) {
    return data.length > 0 && data.every((item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      String(item.title || "").trim() &&
      hasTaskHints(item)
    );
  }

  if (!data || typeof data !== "object") return false;

  if (Array.isArray(data.tasks)) {
    return data.tasks.length > 0 && data.tasks.every((item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      String(item.title || "").trim()
    );
  }

  return Boolean(String(data.title || "").trim() && hasTaskHints(data));
}

export function parseDetectedTaskPayload(payload) {
  const data = parseJson(payload);
  if (!looksLikeTaskPayload(data)) {
    throw new Error("JSON does not match the task payload shape.");
  }

  return {
    data,
    tasks: parseTaskPayload(data)
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

export function fingerprintTaskPayload(payload) {
  const data = parseJson(payload);
  const serialized = stableSerialize(data);

  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}-${serialized.length}`;
}
