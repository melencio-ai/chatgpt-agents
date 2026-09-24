import test from "node:test";
import assert from "node:assert/strict";
import { completeSubtasks } from "../src/tasks/subtask-progress.js";

const subtasks = [
  { id: "stage-0", title: "Preflight", completed: false },
  { id: "stage-1", title: "Build importer", completed: false },
  { id: "stage-2", title: "Ship canvas", completed: true, completedAt: "earlier" }
];

test("completes subtasks by ID without changing the others", () => {
  const result = completeSubtasks(subtasks, ["stage-0"], "now");

  assert.equal(result.changed, true);
  assert.deepEqual(result.subtasks[0], {
    id: "stage-0",
    title: "Preflight",
    completed: true,
    completedAt: "now"
  });
  assert.equal(result.subtasks[1], subtasks[1]);
  assert.equal(result.subtasks[2], subtasks[2]);
});

test("matches IDs and titles case-insensitively and preserves completed timestamps", () => {
  const result = completeSubtasks(subtasks, ["BUILD IMPORTER", "STAGE-2"], "now");

  assert.equal(result.subtasks[1].completed, true);
  assert.equal(result.subtasks[1].completedAt, "now");
  assert.equal(result.subtasks[2].completedAt, "earlier");
});

test("ignores unknown completion identifiers", () => {
  const result = completeSubtasks(subtasks, ["missing"], "now");

  assert.equal(result.changed, false);
  assert.deepEqual(result.subtasks, subtasks);
});
