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

test("inherits audit defaults from the project wrapper", () => {
  const [task] = parseTaskPayload({
    project: {
      title: "Audit",
      audit_mode: "read_only",
      audit_target: { url: "https://app.dynk.ph/" },
      instructions: ["Do not change data"]
    },
    tasks: [{
      id: "audit-1",
      title: "Audit UX",
      audit_focus: ["Booking flow"]
    }]
  });
  assert.equal(task.audit_mode, "read_only");
  assert.equal(task.audit_target.url, "https://app.dynk.ph/");
  assert.deepEqual(task.audit_focus, ["Booking flow"]);
  assert.deepEqual(task.instructions, ["Do not change data"]);
});

test("rejects a task with no title", () => {
  assert.throws(() => parseTaskPayload({ subtasks: [] }), /missing a title/i);
});


test("parses tutorial task configuration", () => {
  const [task] = parseTaskPayload({
    title: "Record tutorial",
    task_mode: "tutorial",
    tutorial: {
      enabled: true,
      title: "How to import contacts",
      pace: "slow"
    },
    audit_mode: "tutorial read-only",
    audit_target: { url: "https://app.gohighlevel.com/" }
  });
  assert.equal(task.task_mode, "tutorial");
  assert.equal(task.tutorial.enabled, true);
  assert.equal(task.tutorial.title, "How to import contacts");
  assert.equal(task.tutorial.pace, "slow");
});

test("recognizes an explicitly described browser automation and its subtask URL", () => {
  const [task] = parseTaskPayload({
    title: "Browser test - send WhatsApp message",
    next_action: "Run this as a browser automation. Wait 10 seconds, open WhatsApp Web, and send the supplied message.",
    subtasks: [
      { title: "Open https://web.whatsapp.com/send?phone=15555550199" },
      { title: "Type exactly: Good morning everyone" },
      { title: "Press Enter to send" }
    ]
  });

  assert.equal(task.task_mode, "browser_automation");
  assert.equal(task.browser_mode, "interactive");
  assert.equal(task.browser_target.url, "https://web.whatsapp.com/send?phone=15555550199");
});
