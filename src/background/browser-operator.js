const BLOCKED_ACTION_WORDS = /\b(save|submit|delete|remove|approve|reject|pay|purchase|confirm|create|invite|send|reset|activate|deactivate|cancel booking|book now|reserve|favorite|unfavorite|refund|void)\b/i;

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return chrome.tabs.get(tabId);
}

async function findTargetTab(targetUrl) {
  const tabs = await chrome.tabs.query({});
  const matches = tabs.filter((tab) => {
    const current = safeUrl(tab.url);
    return current && current.origin === targetUrl.origin;
  });
  return matches.find((tab) => tab.active) ||
    matches.find((tab) => tab.status === "complete") ||
    matches[0] ||
    null;
}

export async function ensureAuditTab(targetUrlValue, preferredTabId = null) {
  const targetUrl = safeUrl(targetUrlValue);
  if (!targetUrl) throw new Error("Invalid audit target URL.");

  if (preferredTabId) {
    try {
      const preferred = await chrome.tabs.get(preferredTabId);
      const current = safeUrl(preferred.url);
      if (current && current.origin === targetUrl.origin) return preferred;
    } catch {
      // fall through
    }
  }

  const existing = await findTargetTab(targetUrl);
  if (existing) return existing;

  const created = await chrome.tabs.create({ url: targetUrl.href, active: false });
  return waitForTabComplete(created.id);
}

const debuggerSessions = new Map();

export async function acquireDebuggerSession(tabId) {
  const existing = debuggerSessions.get(tabId);
  if (existing) {
    existing.refs += 1;
    return existing.debuggee;
  }

  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  await chrome.debugger.sendCommand(debuggee, "Page.enable");
  await chrome.debugger.sendCommand(debuggee, "Runtime.enable");

  debuggerSessions.set(tabId, {
    debuggee,
    refs: 1
  });

  return debuggee;
}

export async function releaseDebuggerSession(tabId) {
  const existing = debuggerSessions.get(tabId);
  if (!existing) return;

  existing.refs -= 1;
  if (existing.refs > 0) return;

  debuggerSessions.delete(tabId);
  try {
    await chrome.debugger.detach(existing.debuggee);
  } catch {
    // Target may already be gone.
  }
}

async function withDebugger(tabId, fn) {
  const debuggee = await acquireDebuggerSession(tabId);
  try {
    return await fn(debuggee);
  } finally {
    await releaseDebuggerSession(tabId);
  }
}

async function evaluate(debuggee, expression) {
  const result = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Browser evaluation failed.");
  }
  return result?.result?.value;
}


const VISUAL_MOUSE_ID = "__chatgpt_agent_visual_mouse__";

function visualMouseExpression({ visible = true, x = null, y = null, label = "Agent", click = false } = {}) {
  const markup = '<svg data-agent-cursor width="24" height="30" viewBox="0 0 24 30" style="position:absolute;left:0;top:0;overflow:visible"><path d="M2 2 2 23 7.7 17.4 11.7 26 15.2 24.4 11.3 16H20L2 2Z" fill="#111827" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"></path></svg><div data-agent-label style="position:absolute;left:19px;top:18px;padding:3px 6px;border-radius:999px;background:#111827;color:#fff;font:600 10px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.25)">Agent</div><div data-agent-ripple style="position:absolute;left:-12px;top:-12px;width:26px;height:26px;border:2px solid rgba(37,99,235,.9);border-radius:999px;opacity:0"></div>';
  const nextX = x === null ? "previousX" : JSON.stringify(Number(x));
  const nextY = y === null ? "previousY" : JSON.stringify(Number(y));

  return `(() => {
    const id = ${JSON.stringify(VISUAL_MOUSE_ID)};
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement("div");
      root.id = id;
      root.setAttribute("aria-hidden", "true");
      root.style.cssText = [
        "position:fixed",
        "left:0",
        "top:0",
        "z-index:2147483647",
        "pointer-events:none",
        "width:1px",
        "height:1px",
        "transform:translate3d(28px,28px,0)",
        "transition:transform 45ms linear",
        "filter:drop-shadow(0 2px 3px rgba(0,0,0,.25))"
      ].join(";");
      root.innerHTML = ${JSON.stringify(markup)};
      document.documentElement.appendChild(root);
    }

    root.style.display = ${JSON.stringify(visible ? "block" : "none")};
    if (!${visible ? "true" : "false"}) return { visible: false };

    const previousX = Number(root.dataset.x || 28);
    const previousY = Number(root.dataset.y || 28);
    const nextX = Number.isFinite(Number(${nextX})) ? Number(${nextX}) : previousX;
    const nextY = Number.isFinite(Number(${nextY})) ? Number(${nextY}) : previousY;
    root.dataset.x = String(nextX);
    root.dataset.y = String(nextY);
    root.style.transform = "translate3d(" + nextX + "px, " + nextY + "px, 0)";

    const labelNode = root.querySelector("[data-agent-label]");
    if (labelNode) labelNode.textContent = ${JSON.stringify(String(label || "Agent"))};

    if (${click ? "true" : "false"}) {
      const ripple = root.querySelector("[data-agent-ripple]");
      if (ripple && ripple.animate) {
        ripple.animate(
          [
            { opacity: 0.95, transform: "scale(.45)" },
            { opacity: 0, transform: "scale(1.55)" }
          ],
          { duration: 700, easing: "ease-out" }
        );
      }
    }
    return { visible: true, x: nextX, y: nextY };
  })()`;
}

async function updateVisualMouse(debuggee, options = {}) {
  return evaluate(debuggee, visualMouseExpression(options));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const TUTORIAL_CAPTION_ID = "__chatgpt_agent_tutorial_caption__";

function tutorialCaptionExpression(text, visible = true) {
  return `(() => {
    const id = ${JSON.stringify(TUTORIAL_CAPTION_ID)};
    let node = document.getElementById(id);
    if (!node) {
      node = document.createElement("div");
      node.id = id;
      node.setAttribute("aria-hidden", "true");
      node.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:28px",
        "transform:translateX(-50%)",
        "z-index:2147483646",
        "pointer-events:none",
        "max-width:min(760px,80vw)",
        "padding:9px 14px",
        "border-radius:10px",
        "background:rgba(17,24,39,.92)",
        "color:#fff",
        "font:600 13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif",
        "box-shadow:0 5px 18px rgba(0,0,0,.28)",
        "text-align:center",
        "backdrop-filter:blur(6px)"
      ].join(";");
      document.documentElement.appendChild(node);
    }
    node.style.display = ${JSON.stringify(visible ? "block" : "none")};
    node.textContent = ${JSON.stringify(String(text || ""))};
    return { visible: ${visible ? "true" : "false"} };
  })()`;
}

async function showTutorialCaption(debuggee, text, visible = true) {
  return evaluate(debuggee, tutorialCaptionExpression(text, visible));
}

function tutorialPauseMs(pace) {
  switch (String(pace || "guided").toLowerCase()) {
    case "fast": return 450;
    case "slow": return 1400;
    default: return 900;
  }
}

async function dispatchPointerMove(debuggee, x, y, { visible = true, label = "Agent" } = {}) {
  const current = await updateVisualMouse(debuggee, { visible, label });
  const startX = Number(current?.x) || 28;
  const startY = Number(current?.y) || 28;
  const targetX = Number(x);
  const targetY = Number(y);

  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    throw new Error("Pointer target coordinates are invalid.");
  }

  const distance = Math.hypot(targetX - startX, targetY - startY);
  const steps = visible
    ? Math.max(8, Math.min(20, Math.ceil(distance / 55)))
    : 1;

  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const eased = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    const nextX = startX + ((targetX - startX) * eased);
    const nextY = startY + ((targetY - startY) * eased);

    await updateVisualMouse(debuggee, {
      visible,
      x: nextX,
      y: nextY,
      label: visible ? `${label} • moving` : label
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: nextX,
      y: nextY,
      button: "none"
    });

    if (visible) await sleep(42);
  }

  await updateVisualMouse(debuggee, { visible, x: targetX, y: targetY, label });
  if (visible) await sleep(120);
}

async function dispatchPointerClick(debuggee, x, y, { visible = true, label = "Agent" } = {}) {
  await dispatchPointerMove(debuggee, x, y, { visible, label });
  await updateVisualMouse(debuggee, {
    visible,
    x,
    y,
    label: visible ? `${label} • click` : label,
    click: true
  });

  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1
  });

  if (visible) await sleep(140);

  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1
  });

  if (visible) {
    await sleep(220);
    await updateVisualMouse(debuggee, { visible, x, y, label });
  }
}

export async function setVisualMouseVisibility(tabId, visible, label = "Agent") {
  return withDebugger(tabId, async (debuggee) => {
    await updateVisualMouse(debuggee, { visible: Boolean(visible), label });
    return { ok: true, visible: Boolean(visible) };
  });
}

const SNAPSHOT_EXPRESSION = `(() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0;
  };
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const elements = Array.from(document.querySelectorAll(
    "a,button,[role='button'],[role='link'],summary,input,select,textarea,[tabindex]"
  ))
    .filter(visible)
    .slice(0, 160)
    .map((el, index) => {
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + (rect.width / 2);
      const centerY = rect.top + (rect.height / 2);
      return {
        index,
        tag: el.tagName.toLowerCase(),
        text: clean(el.innerText || el.value || el.getAttribute("aria-label") || el.title),
        role: el.getAttribute("role") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        href: el.href || "",
        type: el.type || "",
        name: el.name || "",
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        center: {
          xPct: innerWidth ? Number((centerX / innerWidth).toFixed(4)) : 0,
          yPct: innerHeight ? Number((centerY / innerHeight).toFixed(4)) : 0
        }
      };
    });

  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
      pageHeight: document.documentElement.scrollHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    },
    text: clean(document.body?.innerText).slice(0, 16000),
    interactiveElements: elements
  };
})()`;

async function captureViewport(debuggee) {
  const result = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 72,
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true
  });
  return result?.data || "";
}

export async function observeAuditPage(tabId, options = {}) {
  return withDebugger(tabId, async (debuggee) => {
    const visualMouse = options.visualMouse !== false;
    await updateVisualMouse(debuggee, {
      visible: visualMouse,
      label: options.agentLabel || "Agent"
    });
    const snapshot = await evaluate(debuggee, SNAPSHOT_EXPRESSION);
    const screenshot = await captureViewport(debuggee);
    return { snapshot, screenshot };
  });
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    throw new Error("Browser action must be a JSON object.");
  }
  const type = String(action.type || "").trim().toLowerCase();
  if (!type) throw new Error("Browser action is missing type.");
  return { ...action, type };
}

function assertSafeClickLabel(label) {
  if (BLOCKED_ACTION_WORDS.test(String(label || ""))) {
    throw new Error(`Read-only audit blocked state-changing control: "${label}".`);
  }
}

function assertSafeNavigation(url, allowedOrigin) {
  const parsed = safeUrl(url);
  if (!parsed) throw new Error("Invalid navigation URL.");
  if (parsed.origin !== allowedOrigin) {
    throw new Error(`Navigation outside audit origin blocked: ${parsed.origin}`);
  }
  if (BLOCKED_ACTION_WORDS.test(parsed.pathname + " " + parsed.search)) {
    throw new Error("Navigation URL looks state-changing and was blocked by read-only audit policy.");
  }
  return parsed;
}

export async function executeBrowserAction(tabId, targetUrlValue, rawAction, options = {}) {
  const action = normalizeAction(rawAction);
  const targetUrl = safeUrl(targetUrlValue);
  const visualMouse = options.visualMouse !== false;
  const agentLabel = options.agentLabel || "Agent";
  const tutorialMode = options.tutorialMode === true;
  const tutorialDelay = tutorialPauseMs(options.tutorialPace);
  if (!targetUrl) throw new Error("Invalid audit target URL.");

  if (action.type === "wait") {
    const ms = Math.min(5000, Math.max(250, Number(action.ms) || 1000));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true, type: "wait", ms };
  }

  if (action.type === "inspect" || action.type === "capture") {
    return { ok: true, type: action.type };
  }

  return withDebugger(tabId, async (debuggee) => {
    const current = await chrome.tabs.get(tabId);
    const currentUrl = safeUrl(current.url);
    if (!currentUrl || currentUrl.origin !== targetUrl.origin) {
      throw new Error("Audit tab left the allowed origin. Autonomous actions were stopped.");
    }

    await updateVisualMouse(debuggee, { visible: visualMouse, label: agentLabel });

    if (action.type === "navigate") {
      const destination = action.url
        ? assertSafeNavigation(new URL(action.url, currentUrl.href).href, targetUrl.origin)
        : null;
      if (!destination) throw new Error("Navigate action requires url.");
      if (tutorialMode) {
        await showTutorialCaption(debuggee, `Open ${destination.pathname || destination.href}`);
        await sleep(tutorialDelay);
      }
      const result = await chrome.debugger.sendCommand(debuggee, "Page.navigate", {
        url: destination.href
      });
      if (result?.errorText) throw new Error(result.errorText);
      return { ok: true, type: "navigate", url: destination.href };
    }

    if (action.type === "back") {
      const history = await chrome.debugger.sendCommand(debuggee, "Page.getNavigationHistory");
      const nextIndex = Math.max(0, (history?.currentIndex || 0) - 1);
      const entry = history?.entries?.[nextIndex];
      if (!entry) return { ok: true, type: "back", changed: false };
      const destination = assertSafeNavigation(entry.url, targetUrl.origin);
      if (tutorialMode) {
        await showTutorialCaption(debuggee, "Go back");
        await sleep(tutorialDelay);
      }
      await chrome.debugger.sendCommand(debuggee, "Page.navigateToHistoryEntry", { entryId: entry.id });
      return { ok: true, type: "back", changed: true, url: destination.href };
    }

    if (action.type === "scroll") {
      const deltaY = Math.max(-1800, Math.min(1800, Number(action.deltaY) || 700));
      const viewport = await evaluate(debuggee, `(() => ({
        width: window.innerWidth,
        height: window.innerHeight
      }))()`);
      const x = Math.max(40, Math.round((Number(viewport?.width) || 800) * 0.78));
      const y = Math.max(40, Math.round((Number(viewport?.height) || 600) * 0.68));

      if (tutorialMode) {
        await showTutorialCaption(debuggee, deltaY >= 0 ? "Scroll down" : "Scroll up");
        await sleep(Math.round(tutorialDelay * 0.6));
      }
      await dispatchPointerMove(debuggee, x, y, {
        visible: visualMouse,
        label: agentLabel
      });
      await updateVisualMouse(debuggee, {
        visible: visualMouse,
        x,
        y,
        label: visualMouse ? `${agentLabel} • scroll` : agentLabel
      });

      await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY
      });
      if (visualMouse) await sleep(320);

      const value = await evaluate(debuggee, `(() => ({
        scrollY: window.scrollY,
        pageHeight: document.documentElement.scrollHeight
      }))()`);
      await updateVisualMouse(debuggee, {
        visible: visualMouse,
        x,
        y,
        label: agentLabel
      });
      return { ok: true, type: "scroll", ...value };
    }

    if (action.type === "upload_sample_csv") {
      if (!tutorialMode) {
        throw new Error("upload_sample_csv is only available in tutorial mode.");
      }
      const selector = String(action.selector || "input[type=\'file\']").trim();
      await showTutorialCaption(debuggee, "Choose a safe sample CSV");
      await sleep(tutorialDelay);
      const csv = [
        "First Name,Last Name,Email,Phone",
        "Ava,Sample,ava.sample@example.com,+15555550101",
        "Noah,Sample,noah.sample@example.com,+15555550102",
        "Mia,Sample,mia.sample@example.com,+15555550103"
      ].join("\n");
      const result = await evaluate(debuggee, `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return { found: false };
        if (!(input instanceof HTMLInputElement) || input.type !== "file") {
          return { found: true, valid: false };
        }
        const file = new File([${JSON.stringify(csv)}], "tutorial-contacts.csv", { type: "text/csv" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          found: true,
          valid: true,
          filename: file.name,
          size: file.size,
          count: transfer.files.length
        };
      })()`);
      if (!result?.found) throw new Error(`No file input found for selector: ${selector}`);
      if (!result.valid) throw new Error(`Selector does not point to a file input: ${selector}`);
      await sleep(tutorialDelay);
      return { ok: true, type: "upload_sample_csv", ...result };
    }

    if (action.type === "click_point") {
      const viewport = await evaluate(debuggee, `(() => ({
        width: window.innerWidth,
        height: window.innerHeight
      }))()`);

      const width = Math.max(1, Number(viewport?.width) || 1);
      const height = Math.max(1, Number(viewport?.height) || 1);
      const hasPct = Number.isFinite(Number(action.xPct)) && Number.isFinite(Number(action.yPct));
      const x = hasPct
        ? Math.max(0, Math.min(width - 1, Number(action.xPct) * width))
        : Math.max(0, Math.min(width - 1, Number(action.x)));
      const y = hasPct
        ? Math.max(0, Math.min(height - 1, Number(action.yPct) * height))
        : Math.max(0, Math.min(height - 1, Number(action.y)));

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("click_point requires xPct/yPct between 0 and 1, or CSS-pixel x/y.");
      }

      const target = await evaluate(debuggee, `(() => {
        const x = ${JSON.stringify(x)};
        const y = ${JSON.stringify(y)};
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const raw = document.elementFromPoint(x, y);
        if (!raw) return { found: false };

        const clickable = raw.closest("a,button,[role='button'],[role='link'],summary,input,select,textarea,[tabindex]") || raw;
        const style = getComputedStyle(clickable);
        const rect = clickable.getBoundingClientRect();
        const label = clean(
          clickable.innerText ||
          clickable.value ||
          clickable.getAttribute("aria-label") ||
          clickable.title ||
          clickable.getAttribute("name") ||
          clickable.tagName
        );
        const blocked = /\\b(save|submit|delete|remove|approve|reject|pay|purchase|confirm|create|invite|send|reset|activate|deactivate|cancel booking|book now|reserve|favorite|unfavorite|refund|void)\\b/i;
        const interactive = Boolean(
          clickable.matches("a,button,[role='button'],[role='link'],summary,input,select,textarea,[tabindex]")
        );
        const visible = style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0;

        return {
          found: true,
          interactive,
          visible,
          blocked: blocked.test(label),
          label,
          tag: clickable.tagName.toLowerCase(),
          href: clickable.href || "",
          disabled: Boolean(clickable.disabled || clickable.getAttribute("aria-disabled") === "true"),
          x,
          y
        };
      })()`);

      if (!target?.found) throw new Error("No page element exists at that screenshot point.");
      if (!target.visible) throw new Error("The screenshot point resolves to a hidden element.");
      if (!target.interactive) throw new Error(`Screenshot point is not on an interactive control: "${target.label}".`);
      if (target.disabled) throw new Error(`Screenshot point resolves to a disabled control: "${target.label}".`);
      if (target.blocked) throw new Error(`Read-only audit blocked state-changing control: "${target.label}".`);

      if (tutorialMode) {
        await showTutorialCaption(debuggee, `Click ${target.label || "the highlighted control"}`);
        await sleep(tutorialDelay);
      }

      await dispatchPointerClick(debuggee, x, y, {
        visible: visualMouse,
        label: agentLabel
      });
      if (tutorialMode) await sleep(tutorialDelay);

      return {
        ok: true,
        type: "click_point",
        x,
        y,
        xPct: Number((x / width).toFixed(4)),
        yPct: Number((y / height).toFixed(4)),
        label: target.label,
        tag: target.tag,
        href: target.href
      };
    }

    if (action.type === "click_text") {
      const text = String(action.text || "").trim();
      if (!text) throw new Error("click_text requires text.");
      assertSafeClickLabel(text);
      const result = await evaluate(debuggee, `(() => {
        const wanted = ${JSON.stringify(text)}.toLowerCase();
        const blocked = /\\b(save|submit|delete|remove|approve|reject|pay|purchase|confirm|create|invite|send|reset|activate|deactivate|cancel booking|book now|reserve|favorite|unfavorite|refund|void)\\b/i;
        const visible = (el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        };
        const clean = (v) => String(v || "").replace(/\\s+/g, " ").trim();
        const nodes = Array.from(document.querySelectorAll("a,button,[role='button'],[role='link'],summary,[tabindex]")).filter(visible);
        const scored = nodes.map(el => {
          const label = clean(el.innerText || el.getAttribute("aria-label") || el.title);
          const lower = label.toLowerCase();
          const score = lower === wanted ? 3 : (lower.startsWith(wanted) ? 2 : (lower.includes(wanted) ? 1 : 0));
          return { el, label, score };
        }).filter(item => item.score > 0).sort((a,b) => b.score - a.score);
        const item = scored[0];
        if (!item) return { found: false };
        if (blocked.test(item.label)) return { found: true, blocked: true, label: item.label };
        item.el.scrollIntoView({ block: "center", inline: "center" });
        const rect = item.el.getBoundingClientRect();
        return {
          found: true,
          blocked: false,
          label: item.label,
          tag: item.el.tagName.toLowerCase(),
          x: rect.left + (rect.width / 2),
          y: rect.top + (rect.height / 2)
        };
      })()`);
      if (!result?.found) throw new Error(`No visible clickable element found for text: ${text}`);
      if (result.blocked) throw new Error(`Read-only audit blocked state-changing control: "${result.label}".`);
      if (tutorialMode) {
        await showTutorialCaption(debuggee, `Click ${result.label || text}`);
        await sleep(tutorialDelay);
      }
      await dispatchPointerClick(debuggee, result.x, result.y, {
        visible: visualMouse,
        label: agentLabel
      });
      if (tutorialMode) await sleep(tutorialDelay);
      return { ok: true, type: "click_text", ...result };
    }

    if (action.type === "click_selector") {
      const selector = String(action.selector || "").trim();
      if (!selector) throw new Error("click_selector requires selector.");
      const result = await evaluate(debuggee, `(() => {
        const blocked = /\\b(save|submit|delete|remove|approve|reject|pay|purchase|confirm|create|invite|send|reset|activate|deactivate|cancel booking|book now|reserve|favorite|unfavorite|refund|void)\\b/i;
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        const label = String(el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").replace(/\\s+/g, " ").trim();
        if (blocked.test(label)) return { found: true, blocked: true, label };
        el.scrollIntoView({ block: "center", inline: "center" });
        const rect = el.getBoundingClientRect();
        return {
          found: true,
          blocked: false,
          label,
          tag: el.tagName.toLowerCase(),
          x: rect.left + (rect.width / 2),
          y: rect.top + (rect.height / 2)
        };
      })()`);
      if (!result?.found) throw new Error(`No element found for selector: ${selector}`);
      if (result.blocked) throw new Error(`Read-only audit blocked state-changing control: "${result.label}".`);
      if (tutorialMode) {
        await showTutorialCaption(debuggee, `Click ${result.label || "the highlighted control"}`);
        await sleep(tutorialDelay);
      }
      await dispatchPointerClick(debuggee, result.x, result.y, {
        visible: visualMouse,
        label: agentLabel
      });
      if (tutorialMode) await sleep(tutorialDelay);
      return { ok: true, type: "click_selector", ...result };
    }

    throw new Error(`Unsupported browser action: ${action.type}`);
  });
}
