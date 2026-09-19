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


test("tutorial prompt adds guide-specific browser instructions", () => {
  const tutorialTask = {
    ...task,
    tutorial: { enabled: true, title: "Import contacts", pace: "guided" },
    audit_mode: "tutorial read-only",
    audit_target: { url: "https://app.gohighlevel.com/" },
    audit_focus: ["Import contacts"]
  };
  const prompt = buildInitialPrompt(tutorialTask);
  assert.match(prompt, /TUTORIAL, READ-ONLY/);
  assert.match(prompt, /small visible steps/i);
  assert.match(prompt, /screen recording/i);
  assert.match(prompt, /BROWSER_ACTION/);
});


test("browser prompt teaches screenshot-first coordinate actions", () => {
  const visualTask = {
    ...task,
    audit_mode: "read_only",
    audit_target: { url: "https://example.com/" }
  };
  const prompt = buildInitialPrompt(visualTask);
  assert.match(prompt, /SCREENSHOT AWARENESS/);
  assert.match(prompt, /click_point/);
  assert.match(prompt, /xPct/);
  assert.match(prompt, /primary description of the current browser environment/i);
});


test("parses directive lines with indentation and list markers", () => {
  assert.deepEqual(
    parseAgentDirective("Done.\n  AGENT_STATUS: CONTINUE\n - NEXT_ACTION: Recheck Railway staging\n"),
    {
      status: "CONTINUE",
      nextAction: "Recheck Railway staging",
      browserAction: undefined
    }
  );
});

test("uses the last machine-readable directive block in a response", () => {
  assert.deepEqual(
    parseAgentDirective(
      "Example:\nAGENT_STATUS: BLOCKED\nNEXT_ACTION: Example only\n\nFinal:\nAGENT_STATUS: CONTINUE\nNEXT_ACTION: Continue deployment check\n"
    ),
    {
      status: "CONTINUE",
      nextAction: "Continue deployment check",
      browserAction: undefined
    }
  );
});

test("continuation prompt carries the latest next action", () => {
  const prompt = buildContinuationPrompt(
    { ...task, next_action: "Recheck the Railway staging deployment" },
    4
  );
  assert.match(prompt, /Next action from the previous response:/);
  assert.match(prompt, /Recheck the Railway staging deployment/);
});
