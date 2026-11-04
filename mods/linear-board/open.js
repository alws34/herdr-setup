import { exec, window } from "herdr";

// Issue URLs come from the tracker's API, so only https reaches the system's opener:
// no file:, no app schemes, nothing read as an option.
function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

// The system's opener, on this computer even for a space on another machine.
function opener(url) {
  const platform = window()?.platform;
  if (platform === "macos") return ["open", ["--", url]];
  if (platform === "windows") return ["explorer", [url]];
  return ["xdg-open", [url]];
}

export function openUrl(url) {
  const safe = safeUrl(url);
  if (!safe) return;
  const [command, args] = opener(safe);
  exec(command, args).catch(() => {});
}
