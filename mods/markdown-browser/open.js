// Hands a Markdown file to the system's default app for it.
import { exec } from "herdr";

// Only a Markdown file goes to the default app: not a link named *.md to a program or an app
// bundle (the default handler would run it). Resolves with { path } (what to open: the
// checked path itself) or { why }.
async function check(file) {
  // Every byte of the resolved path: $(...) drops trailing newlines, so realpath's line ends
  // in a sentinel that comes off with exactly one newline.
  const r = await exec("sh", ["-c",
    'p=$(realpath -- "$1" && printf x) || exit 1; p=${p%x}; p=${p%?}; [ -f "$p" ] && printf %s "$p"',
    "markdown-browser", file]);
  if (r.code !== 0 || /[\0-\x1f\x7f]/.test(r.stdout) || !/\.(md|mdx|markdown)$/i.test(r.stdout))
    return { why: "Not a Markdown file" };
  return { path: r.stdout };
}

// Resolves with null, or why it couldn't open.
export async function openDefault(file) {
  const { path, why } = await check(file).catch((e) => ({ why: String(e?.message ?? e) }));
  if (why) return why;
  try {
    const r = await exec("open", [path]);
    return r.code === 0 ? null : (r.stderr.trim() || `open exited with ${r.code}`);
  } catch (e) {
    return String(e?.message ?? e);
  }
}
