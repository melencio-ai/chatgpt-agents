function modeText(task) {
  return [task?.task_mode, task?.browser_mode, task?.audit_mode]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
}

export function browserTargetUrl(task) {
  return String(task?.browser_target?.url || task?.audit_target?.url || "").trim();
}

export function isReadOnlyBrowserTask(task) {
  return Boolean(browserTargetUrl(task) && modeText(task).includes("read"));
}

export function isInteractiveBrowserTask(task) {
  const mode = modeText(task);
  return Boolean(
    browserTargetUrl(task) &&
    (mode.includes("browser_automation") || mode.includes("browser automation") || mode.includes("interactive"))
  );
}

export function isAutonomousBrowserTask(task) {
  return isReadOnlyBrowserTask(task) || isInteractiveBrowserTask(task);
}
