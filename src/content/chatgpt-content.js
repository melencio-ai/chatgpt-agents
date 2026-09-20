(() => {
  const MESSAGE_TYPES = {
    CHATGPT_PAGE_READY: "CHATGPT_PAGE_READY",
    CHATGPT_RESPONSE: "CHATGPT_RESPONSE",
    CHATGPT_GENERATING: "CHATGPT_GENERATING",
    TASK_JSON_CANDIDATES: "TASK_JSON_CANDIDATES",
    INJECT_PROMPT: "INJECT_PROMPT",
    ATTACH_IMAGE: "ATTACH_IMAGE",
    STOP_GENERATION: "STOP_GENERATION",
    GET_CHAT_STATE: "GET_CHAT_STATE"
  };

  let submittedByExtension = false;
  let lastReportedAssistantText = "";
  let lastGenerating = false;
  let settleTimer = null;
  let lastTaskJsonSignature = "";
  let lastTaskJsonReportAt = 0;

  const selectors = {
    composer: [
      "#prompt-textarea",
      "textarea#prompt-textarea",
      "textarea[name='prompt']",
      "textarea[data-testid='prompt-textarea']",
      "textarea[placeholder*='Message']",
      "textarea[placeholder*='Ask']",
      "div[contenteditable='true'][data-testid='prompt-textarea']",
      "div[contenteditable='plaintext-only'][data-testid='prompt-textarea']",
      "[role='textbox'][contenteditable='true']",
      "[role='textbox'][contenteditable='plaintext-only']",
      "div.ProseMirror[contenteditable='true']",
      "div.ProseMirror[contenteditable='plaintext-only']",
      "main form textarea",
      "main form [contenteditable='true']",
      "main form [contenteditable='plaintext-only']"
    ],
    sendButton: [
      "button[data-testid='send-button']",
      "button[data-testid*='send']",
      "button[aria-label='Send prompt']",
      "button[aria-label='Send message']",
      "button[aria-label*='Send']",
      "form button[type='submit']"
    ],
    stopButton: [
      "button[data-testid='stop-button']",
      "button[aria-label='Stop streaming']",
      "button[aria-label*='Stop']"
    ],
    assistantMessages: [
      "[data-message-author-role='assistant']",
      "article [data-message-author-role='assistant']"
    ],
    fileInputs: [
      "input[type='file'][accept*='image']",
      "input[type='file']"
    ],
    attachmentButtons: [
      "button[data-testid='composer-plus-btn']",
      "button[aria-label*='Attach']",
      "button[aria-label*='Upload']",
      "button[aria-label*='Add files']",
      "button[aria-label*='photos']",
      "button[aria-label*='files']"
    ]
  };

  let cachedQueryRoots = [document];
  let lastQueryRootScan = 0;

  function getQueryRoots(force = false) {
    const now = Date.now();
    if (!force && now - lastQueryRootScan < 1000) return cachedQueryRoots;

    const roots = [document];
    const seen = new Set(roots);

    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      let elements = [];
      try {
        elements = root.querySelectorAll("*");
      } catch {
        continue;
      }

      for (const element of elements) {
        if (element.shadowRoot && !seen.has(element.shadowRoot)) {
          seen.add(element.shadowRoot);
          roots.push(element.shadowRoot);
        }
      }
    }

    cachedQueryRoots = roots;
    lastQueryRootScan = now;
    return roots;
  }

  function queryAll(selector) {
    const matches = [];
    const seen = new Set();

    for (const root of getQueryRoots()) {
      let elements = [];
      try {
        elements = root.querySelectorAll(selector);
      } catch {
        continue;
      }

      for (const element of elements) {
        if (!seen.has(element)) {
          seen.add(element);
          matches.push(element);
        }
      }
    }

    return matches;
  }

  function firstMatch(list, { visible = false } = {}) {
    for (const selector of list) {
      const elements = queryAll(selector);
      const element = visible ? elements.find(isVisible) : elements[0];
      if (element) return element;
    }
    return null;
  }

  function composerCandidateScore(element) {
    if (!element) return -1;

    const id = String(element.id || "").toLowerCase();
    const testId = String(element.getAttribute("data-testid") || "").toLowerCase();
    const role = String(element.getAttribute("role") || "").toLowerCase();
    const placeholder = String(element.getAttribute("placeholder") || "").toLowerCase();
    const ariaLabel = String(element.getAttribute("aria-label") || "").toLowerCase();
    const className = typeof element.className === "string" ? element.className.toLowerCase() : "";
    const identifyingText = [id, testId, role, placeholder, ariaLabel, className].join(" ");

    let score = 0;
    if (id === "prompt-textarea") score += 120;
    if (/prompt|composer/.test(testId)) score += 100;
    if (role === "textbox") score += 55;
    if (/message|ask|prompt|chat/.test(placeholder)) score += 45;
    if (/message|ask|prompt|chat/.test(ariaLabel)) score += 35;
    if (/prosemirror/.test(className)) score += 25;
    if (element.closest("form")) score += 30;
    if (element.closest("main")) score += 15;
    if (element instanceof HTMLTextAreaElement) score += 15;
    if (element.isContentEditable) score += 15;
    if (/search/.test(identifyingText) && !/prompt|message|ask/.test(identifyingText)) score -= 100;

    const rect = element.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.45) score += 10;

    return score;
  }

  function isComposerCandidate(element) {
    if (!element || !isVisible(element)) return false;
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
    if (element.closest("[inert]")) return false;
    if (element.matches("[role='searchbox'], input[type='search']")) return false;

    const editable = element instanceof HTMLTextAreaElement ||
      element instanceof HTMLInputElement ||
      element.isContentEditable ||
      ["true", "plaintext-only"].includes(element.getAttribute("contenteditable"));

    if (!editable) return false;

    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (element instanceof HTMLInputElement && type && !["text", ""].includes(type)) return false;

    return true;
  }

  function getComposer() {
    const explicitCandidates = selectors.composer
      .flatMap((selector) => queryAll(selector))
      .filter(isComposerCandidate)
      .sort((a, b) => composerCandidateScore(b) - composerCandidateScore(a));

    if (explicitCandidates.length) return explicitCandidates[0];

    getQueryRoots(true);
    const fallbackSelectors = [
      "main form textarea",
      "main form [role='textbox']",
      "main form [contenteditable]:not([contenteditable='false'])",
      "form textarea",
      "form [role='textbox']",
      "form [contenteditable]:not([contenteditable='false'])",
      "main textarea",
      "main [role='textbox'][contenteditable]:not([contenteditable='false'])",
      "main [contenteditable]:not([contenteditable='false'])"
    ];

    return fallbackSelectors
      .flatMap((selector) => queryAll(selector))
      .filter(isComposerCandidate)
      .sort((a, b) => composerCandidateScore(b) - composerCandidateScore(a))[0] || null;
  }

  function isVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" &&
      style.display !== "none" &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function getSendButton() {
    const explicit = selectors.sendButton
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .find((button) => !button.disabled && isVisible(button));
    if (explicit) return explicit;

    const composer = getComposer();
    const form = composer?.closest("form");
    if (!form) return null;

    return Array.from(form.querySelectorAll("button"))
      .filter((button) => !button.disabled && isVisible(button))
      .find((button) => {
        const label = [
          button.getAttribute("aria-label"),
          button.getAttribute("data-testid"),
          button.title,
          button.textContent
        ].filter(Boolean).join(" ").toLowerCase();
        return /send|submit/.test(label) && !/stop|voice|audio|dictat|attach|upload/.test(label);
      }) || null;
  }

  function getStopButton() {
    return firstMatch(selectors.stopButton, { visible: true });
  }

  function getFileInput() {
    return firstMatch(selectors.fileInputs);
  }

  function isGenerating() {
    return Boolean(getStopButton());
  }

  function getLatestAssistantElement() {
    for (const selector of selectors.assistantMessages) {
      const messages = document.querySelectorAll(selector);
      if (messages.length) return messages[messages.length - 1];
    }
    return null;
  }

  function getLatestAssistantText() {
    const element = getLatestAssistantElement();
    return (element?.innerText || element?.textContent || "").trim();
  }

  function normalizeJsonCandidate(value) {
    let text = String(value || "").trim();
    text = text.replace(/^json\s*[\r\n]+/i, "").trim();
    if (text.length < 20) return "";
    if (!((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) {
      return "";
    }
    return text;
  }

  function extractJsonCandidates(element) {
    if (!element) return [];

    const candidates = new Set();
    const addCandidate = (value) => {
      const candidate = normalizeJsonCandidate(value);
      if (candidate) candidates.add(candidate);
    };

    for (const node of element.querySelectorAll("pre code, pre")) {
      addCandidate(node.innerText || node.textContent || "");
    }

    const fullText = element.innerText || element.textContent || "";
    for (const match of fullText.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      addCandidate(match[1]);
    }

    return Array.from(candidates).slice(0, 12);
  }

  function reportTaskJsonCandidates() {
    if (isGenerating()) return false;

    const element = getLatestAssistantElement();
    const candidates = extractJsonCandidates(element);
    if (!candidates.length) return false;

    const signature = candidates.join("\n\u241e\n");
    const now = Date.now();
    if (signature === lastTaskJsonSignature && now - lastTaskJsonReportAt < 15000) {
      return false;
    }

    lastTaskJsonSignature = signature;
    lastTaskJsonReportAt = now;
    safeSend({
      type: MESSAGE_TYPES.TASK_JSON_CANDIDATES,
      candidates,
      url: location.href
    });
    return true;
  }

  function hasAgentDirective(text) {
    return /^[ \t]*(?:[-*]\s*)?AGENT_STATUS:\s*(CONTINUE|COMPLETE|BLOCKED)\s*$/im.test(
      String(text || "")
    );
  }

  function reportLatestAssistant({ allowUnsubmitted = false } = {}) {
    if (isGenerating()) return false;
    const latest = getLatestAssistantText();
    if (!latest || latest === lastReportedAssistantText) return false;
    if (!submittedByExtension && !(allowUnsubmitted && hasAgentDirective(latest))) return false;

    lastReportedAssistantText = latest;
    submittedByExtension = false;
    safeSend({
      type: MESSAGE_TYPES.CHATGPT_RESPONSE,
      text: latest,
      url: location.href
    });
    return true;
  }

  function setNativeValue(element, value) {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);

    element.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value
    }));

    document.execCommand("insertText", false, value);

    if (!(element.innerText || element.textContent || "").trim()) {
      element.textContent = value;
    }

    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", {
      bubbles: true,
      key: " ",
      code: "Space"
    }));
  }

  async function waitFor(predicate, timeoutMs = 12000, intervalMs = 150) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  function composerHasText(composer) {
    if (!composer) return false;
    const value = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
      ? composer.value
      : composer.innerText || composer.textContent || "";
    return Boolean(String(value || "").trim());
  }

  function pressEnterToSend(composer) {
    composer.focus();
    const options = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13
    };
    const down = composer.dispatchEvent(new KeyboardEvent("keydown", options));
    composer.dispatchEvent(new KeyboardEvent("keypress", options));
    composer.dispatchEvent(new KeyboardEvent("keyup", options));
    return down;
  }

  function describeComposerEnvironment() {
    const textareas = queryAll("textarea").filter(isVisible).length;
    const textboxes = queryAll("[role='textbox']").filter(isVisible).length;
    const editables = queryAll("[contenteditable]:not([contenteditable='false'])").filter(isVisible).length;
    return `url=${location.href}; visible textareas=${textareas}; textboxes=${textboxes}; contenteditables=${editables}`;
  }

  async function injectPrompt(prompt) {
    const composer = await waitFor(getComposer, 20000, 200);
    if (!composer) {
      throw new Error(`ChatGPT composer was not found. ${describeComposerEnvironment()}`);
    }

    composer.focus();
    setNativeValue(composer, String(prompt || ""));

    const populated = await waitFor(() => composerHasText(composer), 2500, 80);
    if (!populated) {
      throw new Error("ChatGPT composer did not accept the injected prompt.");
    }

    submittedByExtension = true;
    lastReportedAssistantText = getLatestAssistantText();

    const sendButton = await waitFor(getSendButton, 3500, 100);
    if (sendButton) {
      sendButton.click();
    } else {
      pressEnterToSend(composer);
    }

    const started = await waitFor(
      () => isGenerating() || getLatestAssistantText() !== lastReportedAssistantText || !composerHasText(composer),
      4500,
      120
    );

    if (!started) {
      submittedByExtension = false;
      throw new Error("ChatGPT prompt was populated but could not be submitted.");
    }

    return true;
  }

  function base64ToFile(base64, filename, mimeType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], filename, { type: mimeType });
  }

  function setFiles(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchFileDrop(file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const target = getComposer()?.closest("form") || getComposer() || document.body;

    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      });
      target.dispatchEvent(event);
    }
  }

  async function attachImage({ base64, filename, mimeType }) {
    if (!base64) throw new Error("Screenshot payload is empty.");
    const file = base64ToFile(base64, filename || "audit-evidence.jpg", mimeType || "image/jpeg");

    let input = getFileInput();
    if (!input) {
      const attachmentButton = firstMatch(selectors.attachmentButtons);
      if (attachmentButton) {
        attachmentButton.click();
        input = await waitFor(getFileInput, 2500, 100);
      }
    }

    if (input) {
      setFiles(input, file);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return "file-input";
    }

    dispatchFileDrop(file);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return "drag-drop";
  }

  function stopGeneration() {
    const stopButton = getStopButton();
    if (stopButton) stopButton.click();
    return Boolean(stopButton);
  }

  function safeSend(message) {
    try {
      const maybePromise = chrome.runtime.sendMessage(message);
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch {
      // Extension may have reloaded while this content script was alive.
    }
  }

  function checkState() {
    const generating = isGenerating();
    if (submittedByExtension && generating && !lastGenerating) {
      safeSend({ type: MESSAGE_TYPES.CHATGPT_GENERATING, url: location.href });
    }
    lastGenerating = generating;

    if (generating) return;

    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      reportTaskJsonCandidates();
      reportLatestAssistant({ allowUnsubmitted: true });
    }, 1200);
  }

  const observer = new MutationObserver(checkState);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-label", "data-testid"]
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message?.type) {
          case MESSAGE_TYPES.INJECT_PROMPT:
            await injectPrompt(message.prompt);
            sendResponse({ ok: true });
            break;
          case MESSAGE_TYPES.ATTACH_IMAGE: {
            const method = await attachImage(message);
            sendResponse({ ok: true, method });
            break;
          }
          case MESSAGE_TYPES.STOP_GENERATION:
            sendResponse({ ok: true, stopped: stopGeneration() });
            break;
          case MESSAGE_TYPES.GET_CHAT_STATE:
            sendResponse({
              ok: true,
              ready: Boolean(getComposer()),
              generating: isGenerating(),
              latestAssistantText: getLatestAssistantText(),
              url: location.href
            });
            break;
          default:
            sendResponse({ ok: false, error: "Unknown content message." });
        }
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  });

  function announceReady() {
    safeSend({ type: MESSAGE_TYPES.CHATGPT_PAGE_READY, url: location.href });
    setTimeout(() => {
      reportTaskJsonCandidates();
      reportLatestAssistant({ allowUnsubmitted: true });
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announceReady, { once: true });
  } else {
    announceReady();
  }

  let previousUrl = location.href;
  setInterval(() => {
    if (location.href !== previousUrl) {
      previousUrl = location.href;
      safeSend({ type: MESSAGE_TYPES.CHATGPT_PAGE_READY, url: location.href });
    }
    reportTaskJsonCandidates();
    reportLatestAssistant({ allowUnsubmitted: true });
  }, 1500);
})();
