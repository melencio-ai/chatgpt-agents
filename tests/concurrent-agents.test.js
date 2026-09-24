import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  MAX_CONCURRENT_AGENTS,
  normalizeMaxConcurrentAgents
} from "../src/shared/constants.js";
import { getState } from "../src/storage/repository.js";
import { ensureAuditTab } from "../src/background/browser-operator.js";

test("concurrent agent setting defaults to one and permits up to three", () => {
  assert.equal(MAX_CONCURRENT_AGENTS, 3);
  assert.equal(DEFAULT_SETTINGS.maxConcurrentAgents, 1);
  assert.equal(normalizeMaxConcurrentAgents(undefined), 1);
  assert.equal(normalizeMaxConcurrentAgents(0), 1);
  assert.equal(normalizeMaxConcurrentAgents("2"), 2);
  assert.equal(normalizeMaxConcurrentAgents(8), 3);
});

test("version 2 state migrates to the safe one-agent default", async () => {
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({
          chatgptAgentsState: {
            version: 2,
            tasks: {},
            agents: {},
            runs: {},
            settings: { maxConcurrentAgents: 1 }
          }
        })
      }
    }
  };

  const state = await getState();
  assert.equal(state.version, 3);
  assert.equal(state.settings.maxConcurrentAgents, 1);
});

test("new agent audits create a dedicated target tab", async () => {
  let createCount = 0;
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 10, url: "https://example.com/existing", status: "complete", active: true }],
      create: async ({ url }) => {
        createCount += 1;
        return { id: 20, url, status: "complete", active: false };
      },
      get: async (tabId) => ({ id: tabId, url: "https://example.com/", status: "complete" })
    }
  };

  const tab = await ensureAuditTab("https://example.com/", null, { reuseExisting: false });
  assert.equal(tab.id, 20);
  assert.equal(createCount, 1);
});

test("resuming an audit keeps its own preferred tab", async () => {
  let queried = false;
  globalThis.chrome = {
    tabs: {
      query: async () => {
        queried = true;
        return [];
      },
      get: async (tabId) => ({ id: tabId, url: "https://example.com/current", status: "complete" }),
      create: async () => {
        throw new Error("should not create a tab");
      }
    }
  };

  const tab = await ensureAuditTab("https://example.com/", 30, {
    excludedTabIds: [10, 20],
    reuseExisting: true
  });
  assert.equal(tab.id, 30);
  assert.equal(queried, false);
});

test("a missing preferred tab never falls back to another agent's claimed tab", async () => {
  globalThis.chrome = {
    tabs: {
      query: async () => [
        { id: 40, url: "https://example.com/claimed", status: "complete", active: true }
      ],
      get: async (tabId) => {
        if (tabId === 30) throw new Error("closed");
        return { id: tabId, url: "https://example.com/", status: "complete" };
      },
      create: async ({ url }) => ({ id: 50, url, status: "complete", active: false })
    }
  };

  const tab = await ensureAuditTab("https://example.com/", 30, {
    excludedTabIds: [40],
    reuseExisting: true
  });
  assert.equal(tab.id, 50);
});
