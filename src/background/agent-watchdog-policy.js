import { AGENT_STATES, EXECUTION_MODES } from "../shared/constants.js";

export const AGENT_WATCHDOG_ALARM = "chatgpt-agent-watchdog";
export const AGENT_WATCHDOG_INTERVAL_MINUTES = 1;
export const AGENT_STALE_TIMEOUT_MS = 4 * 60 * 1000;
export const AGENT_WAKE_COOLDOWN_MS = 90 * 1000;
export const MAX_AGENT_WAKE_ATTEMPTS = 3;

const STALE_STATES = new Set([
  AGENT_STATES.CREATING_TAB,
  AGENT_STATES.WAITING_FOR_CHATGPT,
  AGENT_STATES.READY,
  AGENT_STATES.INJECTING_PROMPT,
  AGENT_STATES.SUBMITTED,
  AGENT_STATES.GENERATING,
  AGENT_STATES.EVALUATING,
  AGENT_STATES.BROWSER_ACTING
]);

const HUMAN_ONLY_ERROR = /captcha|log[ -]?in|sign[ -]?in|authentication|permission|access denied|restricted by policy|human input|tab (?:was )?closed|cancelled/i;
const TRANSIENT_ERROR = /timeout|timed out|stale|temporar|unavailable|connection|receiving end|message port|network|load|loading|failed to fetch|prompt injection|reattach|observe the browser|did not (?:finish|respond)|could not start/i;

function timestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function agentInactivityMs(agent, nowMs = Date.now()) {
  const lastProgress = timestampMs(agent?.lastProgressAt || agent?.updatedAt || agent?.createdAt);
  return lastProgress ? Math.max(0, nowMs - lastProgress) : Number.POSITIVE_INFINITY;
}

export function isRecoverableAgentError(message, { needsUser = false } = {}) {
  const value = String(message || "").trim();
  if (HUMAN_ONLY_ERROR.test(value)) return false;
  if (!needsUser) return true;
  return TRANSIENT_ERROR.test(value);
}

export function getAgentRecoveryDecision(agent, nowMs = Date.now()) {
  if (!agent || agent.recoveryExhausted) return null;
  if (agent.mode === EXECUTION_MODES.MANUAL) return null;
  if ([AGENT_STATES.COMPLETE, AGENT_STATES.CANCELLED, AGENT_STATES.PAUSED, AGENT_STATES.QUEUED].includes(agent.state)) {
    return null;
  }

  let reason = "";
  if (agent.state === AGENT_STATES.ERROR && isRecoverableAgentError(agent.error)) {
    reason = `recoverable error: ${agent.error || "unknown error"}`;
  } else if (
    agent.state === AGENT_STATES.NEEDS_USER &&
    isRecoverableAgentError(agent.error, { needsUser: true })
  ) {
    reason = `transient blocker: ${agent.error}`;
  } else if (STALE_STATES.has(agent.state) && agentInactivityMs(agent, nowMs) >= AGENT_STALE_TIMEOUT_MS) {
    reason = `${String(agent.state).toLowerCase().replaceAll("_", " ")} timed out`;
  }

  if (!reason) return null;

  const attempts = Math.max(0, Number(agent.wakeAttemptCount) || 0);
  if (attempts >= MAX_AGENT_WAKE_ATTEMPTS) {
    return { reason, attempts, exhausted: true };
  }

  const lastWakeAt = timestampMs(agent.lastWakeAt);
  if (lastWakeAt && nowMs - lastWakeAt < AGENT_WAKE_COOLDOWN_MS) return null;

  return { reason, attempts, exhausted: false };
}
