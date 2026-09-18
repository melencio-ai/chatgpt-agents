import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialPrompt,
  buildContinuationPrompt,
  buildBrowserObservationPrompt,
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

test("audit prompt explains autonomous read-only browser actions", () => {
  const auditTask = {
    ...task,
    audit_mode: "read_only",
    audit_target: { url: "https://app.dynk.ph/" },
    audit_focus: ["Booking journey"],
    deliverables: ["Findings"],
    instructions: ["Do not save changes"]
  };
  const prompt = buildInitialPrompt(auditTask);
  assert.match(prompt, /READ-ONLY/);
  assert.match(prompt, /BROWSER_ACTION/);
  assert.match(prompt, /Do not ask the user to manually navigate/i);
  assert.match(prompt, /app\.dynk\.ph/);
});

test("browser observation contains page state", () => {
  const auditTask = {
    ...task,
    audit_mode: "read_only",
    audit_target: { url: "https://app.dynk.ph/" }
  };
  const prompt = buildBrowserObservationPrompt(auditTask, {
    snapshot: {
      url: "https://app.dynk.ph/venues/",
      title: "Venues",
      viewport: { width: 1280, height: 720 },
      text: "Venues Court Reservation",
      interactiveElements: [
        { index: 0, tag: "a", text: "Locations", role: "link", href: "https://app.dynk.ph/locations/", disabled: false }
      ]
    }
  }, 2, { ok: true, type: "scroll" });
  assert.match(prompt, /Browser observation 2/);
  assert.match(prompt, /Venues Court Reservation/);
  assert.match(prompt, /Locations/);
});

test("parses browser action directive", () => {
  assert.deepEqual(
    parseAgentDirective('Working.\nBROWSER_ACTION: {"type":"click_text","text":"Locations"}\nAGENT_STATUS: CONTINUE\nNEXT_ACTION: Open locations\n'),
    {
      status: "CONTINUE",
      nextAction: "Open locations",
      browserAction: { type: "click_text", text: "Locations" }
    }
  );
});

test("parses non-browser directive with undefined browser action", () => {
  assert.deepEqual(
    parseAgentDirective("Done.\nAGENT_STATUS: CONTINUE\nNEXT_ACTION: Test it\n"),
    {
      status: "CONTINUE",
      nextAction: "Test it",
      browserAction: undefined
    }
  );
});
