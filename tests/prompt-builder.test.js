import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialPrompt,
  buildContinuationPrompt,
  parseAgentDirective
} from "../src/tasks/prompt-builder.js";

const task = {
  title: "Build extension",
  project: "Agents",
  priority: "P3 - Normal",
  status: "Now",
  owner: "Melencio",
  waiting_on: "",
  next_action: "Implement loader",
  subtasks: [
    { title: "Architecture", completed: true },
    { title: "JSON loader", completed: false }
  ]
};

test("initial prompt contains task context and machine-readable footer", () => {
  const prompt = buildInitialPrompt(task);
  assert.match(prompt, /Build extension/);
  assert.match(prompt, /\[x\] Architecture/);
  assert.match(prompt, /AGENT_STATUS:/);
});

test("continuation prompt includes continuation number", () => {
  assert.match(buildContinuationPrompt(task, 3), /continuation 3/i);
});

test("audit prompt enforces read-only evidence-grounded behavior", () => {
  const prompt = buildInitialPrompt({
    ...task,
    audit_mode: "read_only",
    audit_target: { url: "https://app.dynk.ph/" },
    audit_focus: ["Booking journey"],
    deliverables: ["Findings"],
    instructions: ["Do not save changes"]
  });
  assert.match(prompt, /READ-ONLY/);
  assert.match(prompt, /app\.dynk\.ph/);
  assert.match(prompt, /Do not invent/);
  assert.match(prompt, /AGENT_STATUS: BLOCKED/);
});

test("parses agent directive", () => {
  assert.deepEqual(parseAgentDirective("Done.\nAGENT_STATUS: CONTINUE\nNEXT_ACTION: Test it\n"), {
    status: "CONTINUE",
    nextAction: "Test it"
  });
});
