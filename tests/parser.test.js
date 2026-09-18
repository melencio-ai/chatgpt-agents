import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskPayload } from "../src/tasks/parser.js";

const sample = {
  title: "Build browser extension to automate multiple ChatGPT tabs",
  project: "ChatGPT Tab Manager Extension",
  owner: "Melencio",
  priority: "P3 - Normal",
  status: "Now",
  next_action: "Design the architecture",
  subtasks: [
    { title: "Design architecture", completed: false },
    { title: "Implement JSON loading", completed: false }
  ],
  source_transcript_id: 448
};

test("parses the user's single-task JSON shape", () => {
  const [task] = parseTaskPayload(sample);
  assert.equal(task.id, "task-transcript-448");
  assert.equal(task.project, "ChatGPT Tab Manager Extension");
  assert.equal(task.subtasks.length, 2);
  assert.equal(task.subtasks[0].id, "task-transcript-448-subtask-1");
  assert.equal(task.source.transcript_id, 448);
});

test("parses a project wrapper with tasks", () => {
  const [task] = parseTaskPayload({
    project: { title: "Alpha", owner: "Owner" },
    tasks: [{ title: "Task one", subtasks: ["Do thing"] }]
  });
  assert.equal(task.project, "Alpha");
  assert.equal(task.owner, "Owner");
  assert.equal(task.subtasks[0].title, "Do thing");
});

test("rejects a task with no title", () => {
  assert.throws(() => parseTaskPayload({ subtasks: [] }), /missing a title/i);
});
