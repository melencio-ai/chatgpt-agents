import test from "node:test";
import assert from "node:assert/strict";
import {
  fingerprintTaskPayload,
  looksLikeTaskPayload,
  parseDetectedTaskPayload
} from "../src/tasks/detected-task-json.js";

test("recognizes a project wrapper with tasks", () => {
  const payload = {
    project: { title: "EVNTS", owner: "Melencio" },
    tasks: [{
      id: "checkout-1",
      title: "Build checkout",
      subtasks: [{ title: "Trace flow", completed: false }]
    }]
  };

  assert.equal(looksLikeTaskPayload(payload), true);
  const result = parseDetectedTaskPayload(payload);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, "checkout-1");
});

test("recognizes a single task with task-specific fields", () => {
  assert.equal(looksLikeTaskPayload({
    title: "Audit checkout",
    project: "EVNTS",
    next_action: "Inspect Stripe flow"
  }), true);
});

test("rejects unrelated JSON that only happens to have a title", () => {
  assert.equal(looksLikeTaskPayload({
    title: "Seat A1",
    price: 1000,
    available: true
  }), false);
});

test("fingerprint ignores object key order and whitespace", () => {
  const first = '{ "project": {"title":"EVNTS"}, "tasks":[{"title":"Task","subtasks":[]}]}';
  const second = '{"tasks":[{"subtasks":[],"title":"Task"}],"project":{"title":"EVNTS"}}';
  assert.equal(fingerprintTaskPayload(first), fingerprintTaskPayload(second));
});
