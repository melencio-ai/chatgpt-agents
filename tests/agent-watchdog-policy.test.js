import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_STATES, EXECUTION_MODES } from "../src/shared/constants.js";
import {
  AGENT_STALE_TIMEOUT_MS,
  AGENT_WAKE_COOLDOWN_MS,
  MAX_AGENT_WAKE_ATTEMPTS,
  agentInactivityMs,
  getAgentRecoveryDecision,
  isRecoverableAgentError
} from "../src/background/agent-watchdog-policy.js";

const now = Date.parse("2026-09-24T12:00:00.000Z");

function agent(patch = {}) {
  return {
    mode: EXECUTION_MODES.AUTO,
    state: AGENT_STATES.SUBMITTED,
    lastProgressAt: new Date(now - AGENT_STALE_TIMEOUT_MS - 1).toISOString(),
    wakeAttemptCount: 0,
    ...patch
  };
}

test("detects a stale autonomous agent", () => {
  const decision = getAgentRecoveryDecision(agent(), now);
  assert.match(decision.reason, /submitted timed out/);
  assert.equal(decision.exhausted, false);
});

test("does not wake a recently progressing or manual agent", () => {
  assert.equal(getAgentRecoveryDecision(agent({ lastProgressAt: new Date(now - 1000).toISOString() }), now), null);
  assert.equal(getAgentRecoveryDecision(agent({ mode: EXECUTION_MODES.MANUAL }), now), null);
});

test("detects recoverable errors but preserves human-only blockers", () => {
  assert.equal(isRecoverableAgentError("Prompt injection failed: receiver unavailable"), true);
  assert.equal(isRecoverableAgentError("Login required"), false);
  assert.match(
    getAgentRecoveryDecision(agent({ state: AGENT_STATES.ERROR, error: "Network timeout" }), now).reason,
    /recoverable error/
  );
  assert.equal(
    getAgentRecoveryDecision(agent({ state: AGENT_STATES.NEEDS_USER, error: "CAPTCHA required" }), now),
    null
  );
});

test("honors wake cooldown and reports exhausted retries", () => {
  assert.equal(
    getAgentRecoveryDecision(agent({
      lastWakeAt: new Date(now - AGENT_WAKE_COOLDOWN_MS + 1).toISOString(),
      wakeAttemptCount: 1
    }), now),
    null
  );

  const exhausted = getAgentRecoveryDecision(agent({ wakeAttemptCount: MAX_AGENT_WAKE_ATTEMPTS }), now);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.attempts, 3);
});

test("measures inactivity from explicit progress timestamps", () => {
  assert.equal(agentInactivityMs(agent({ lastProgressAt: new Date(now - 5000).toISOString() }), now), 5000);
});
