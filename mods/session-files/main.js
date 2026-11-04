// Session files: the second tab row, under the session tabs (vscode layout). Each Herdr tab
// (a Claude session) keeps its own open files in shared "session-files":
// { [tabId]: { files: [{ path, on }], active: path | null } }. files-plus adds to it on a file
// click (props.session). The row shows "Terminal" plus the shown session's files, and points
// the layout's "work" stack at the terminal ("main") or the file view ("file-view", the
// editor mod with props.session), so switching sessions switches the files with it.
// A tab running Claude Code also gets a "Chat" pill before "Terminal": the chat mod's view of the
// same session (stack child "chat"). Which of the two a tab shows is shared "chat.view"
// ({ [tabId]: "chat" | "terminal" }); Claude tabs default to Chat, Terminal one click away.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, layout, shared, setShared, run, theme, notify } from "herdr";

const KEY = "session-files", DIRTY = "session-files.dirty", VIEW = "chat.view";
const base = (path) => path.split("/").pop();

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// A file tab unrolls open like a scroll instead of popping in: it starts 0 wide and slides out
// to the width it measures (`widths`, by key). Same as tabs-vs's (mods can't share code).
function unroll(widths, key, el) {
  const w = widths[key] ?? 0;
  return h_flex().flex_none().h_full().items_center().overflow_hidden().w(w).opacity(w ? 1 : 0)
    .transition("width", { duration: 260, easing: "ease-out" }).transition("opacity", 200)
    .child(el.on_size_change((size, cx) => {
      if (Math.abs((widths[key] ?? 0) - size.width) < 0.5) return;
      widths[key] = size.width;
      cx.notify();
    }));
}

export default class SessionFiles extends View {
  init() {
    this.widths = {};
  }

  render() {
    const t = theme();
    const tab = spaces().find((s) => s.active)?.tabs.find((x) => x.active);
    const all = shared(KEY) ?? {};
    const entry = (tab && all[tab.id]) || { files: [], active: null };
    const set = (next) => setShared(KEY, { ...shared(KEY), [tab.id]: next });

    // Follow the shown session: its active file, else its chat or terminal.
    const stack = find(layout(), "work");
    const claude = Boolean(tab) && panes().some((p) => p.tab === tab.id && p.terminal && (p.program?.key === "claude" || p.app === "claude-code"));
    const hasChat = claude && Boolean(stack?.children?.some((c) => c.id === "chat"));
    const view = (shared(VIEW) ?? {})[tab?.id] ?? "chat"; // Claude tabs open in Chat; Terminal is one click away
    const chat = hasChat && view === "chat";
    const showView = (v) => {
      setShared(VIEW, { ...(shared(VIEW) ?? {}), [tab.id]: v });
      if (entry.active) set({ ...entry, active: null });
    };
    const want = entry.active ? "file-view" : chat ? "chat" : "main";
    if (stack && stack.active !== want) run("layout.select", { stack: "work", child: want });

    const dirty = shared(DIRTY) ?? [];
    const close = (path) => {
      if (dirty.includes(path)) {
        notify({ title: `Unsaved changes: ${base(path)}`, body: "Save it (⌘S) before closing.", level: "warning" });
        return;
      }
      const i = entry.files.findIndex((f) => f.path === path);
      const files = entry.files.filter((f) => f.path !== path);
      const active = entry.active !== path ? entry.active : (files[i] ?? files[i - 1])?.path ?? null;
      set({ files, active });
    };
    const pill = (id, on, label, tooltip, select, extra) => h_flex().id(id).h(24).px(9).gap(6).flex_none().items_center().rounded(6)
      .text_size(12).border(1).border_color(on ? t.border : t.chrome).bg(on ? t.raised : t.chrome)
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).tooltip(tooltip)
      .on_click(select).child(div().max_w(200).truncate().child(label)).when(Boolean(extra), (el) => extra(el));

    return h_flex().id("session-files").size_full().min_w(0).px(10).gap(3).items_center().bg(t.chrome)
      .border_b(1).border_color(t.border).overflow_x_scrollbar()
      .when(Boolean(tab), (el) => el
        .when(hasChat, (el) => el.child(pill("sf-chat", !entry.active && chat, "Chat", "This session as a chat", () => showView("chat"))))
        .child(pill("sf-terminal", !entry.active && !chat, "Terminal", "This session's terminal", () => hasChat ? showView("terminal") : set({ ...entry, active: null })))
        .children(entry.files.map((f) => unroll(this.widths, `${tab.id}:${f.path}`, pill(`sf-${f.path}`, entry.active === f.path, base(f.path), f.path,
          () => set({ ...entry, active: f.path }),
          (el) => el.on_mouse_down("middle", () => close(f.path))
            .child(div().id(`sf-close-${f.path}`).size(16).flex().items_center().justify_center().rounded(4)
              .text_color(dirty.includes(f.path) ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); close(f.path); })
              .child(dirty.includes(f.path) ? "●" : svg("mods/pane/close.svg").size(11))))))));
  }
}
