(() => {
  const MESSAGE_TYPES = {
    CHATGPT_PAGE_READY: "CHATGPT_PAGE_READY",
    CHATGPT_RESPONSE: "CHATGPT_RESPONSE",
    CHATGPT_GENERATING: "CHATGPT_GENERATING",
    INJECT_PROMPT: "INJECT_PROMPT",
    ATTACH_IMAGE: "ATTACH_IMAGE",
    STOP_GENERATION: "STOP_GENERATION",
    GET_CHAT_STATE: "GET_CHAT_STATE"
  };

  let submittedByExtension = false;
  let lastReportedAssistantText = "";
  let lastGenerating = false;
  let settleTimer = null;

  const selectors = {
    composer: [
      "#prompt-textarea",
      "textarea[data-testid='prompt-textarea']",
      "div[contenteditable='true'][data-testid='prompt-textarea']",
      "main form div[contenteditable='true']"
    ],
    sendButton: [
      "button[data-testid='send-button']",
      "button[aria-label='Send prompt']",
      "button[aria-label*='Send']"
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

  function firstMatch(list) {
    for (const selector of list) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function getComposer() {
    return firstMatch(selectors.composer);
  }

  function getSendButton() {
    return selectors.sendButton
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .find((button) => !button.disabled) || null;
  }

  function getStopButton() {
    return firstMatch(selectors.stopButton);
  }

  function getFileInput() {
    return firstMatch(selectors.fileInputs);
  }

  function isGenerating() {
    return Boolean(getStopButton());
  }

  function getLatestAssistantText() {
    for (const selector of selectors.assistantMessages) {
      const messages = document.querySelectorAll(selector);
      if (messages.length) {
        return (messages[messages.length - 1].innerText || messages[messages.length - 1].textContent || "").trim();
      }
    }
    return "";
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
    document.execCommand("insertText", false, value);
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value
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

  async function injectPrompt(prompt) {
    const composer = await waitFor(getComposer);
    if (!composer) throw new Error("ChatGPT composer was not found.");
    composer.focus();
    setNativeValue(composer, String(prompt || ""));

    const sendButton = await waitFor(getSendButton, 5000, 100);
    if (!sendButton) throw new Error("ChatGPT send button did not become available.");

    submittedByExtension = true;
    lastReportedAssistantText = getLatestAssistantText();
    sendButton.click();
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

    if (!submittedByExtension || generating) return;

    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (isGenerating()) return;
      const latest = getLatestAssistantText();
      if (!latest || latest === lastReportedAssistantText) return;
      lastReportedAssistantText = latest;
      submittedByExtension = false;
      safeSend({
        type: MESSAGE_TYPES.CHATGPT_RESPONSE,
        text: latest,
        url: location.href
      });
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
  }, 1000);
})();
