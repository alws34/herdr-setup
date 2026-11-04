// Side chat: a pane on the right of a Claude tab for quick questions on the side, like the Claude
// desktop app's Side chat (asked 2026-11-01). Opened by the tab bar's "Side chat" button (tabs-vs),
// which splits it right of the tab's Claude pane with props { tab }.
// Each question runs ask.sh: the first forks the tab's Claude session (so the side Claude knows the
// whole conversation, and the main session is never touched), follow-ups continue that fork.
// Read-only by design: ask.sh gives the side Claude only Read, Grep and Glob, and no MCP servers.
// The conversation lives for the app's run (globalThis, by tab), so closing and reopening keeps it.
// In the vscode layout's tools panel it has no props.tab and follows the shown tab, showing that
// tab's own conversation.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea, TextView } from "gpui-base";
import { panes, theme, props, exec, appHome, home, readTextFile, spaces } from "herdr";

const chats = (globalThis.__sideChats ??= {});

export default class SideChat extends View {
  init(_props, cx) {
    // Tabs with a question on its way, per copy: a reload or layout switch mid-question starts
    // with none, instead of a "Thinking…" that never ends.
    this.busy = new Set();
    // Multi-line like the chat: Enter asks; Shift/Cmd+Enter adds a line (2026-11-01).
    this.input = TextareaState.new({ placeholder: "Ask a quick question" });
    this.input.set_auto_grow(1, 8);
    this.input.on("submit", (e, cx) => { if (!e.shift && !e.secondary) this.ask(cx); });
  }

  get tab() { return props()?.tab ?? spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null; }
  get chat() { return (chats[this.tab] ??= { side: null, messages: [] }); }

  // The tab's Claude pane: its terminal (for the session) and folder (claude resumes per folder).
  claude() {
    return panes().find((p) => p.tab === this.tab && p.program?.agent && p.terminal) ?? null;
  }

  ask(cx) {
    const q = this.input.value().trim(), tab = this.tab, chat = this.chat;
    if (!q || this.busy.has(tab)) return;
    const pane = this.claude();
    this.input.set_value("");
    chat.messages.push({ who: "you", text: q });
    // ask.sh finds the tab's Claude session among this machine's processes.
    const remote = spaces().find((s) => s.tabs.some((t) => t.id === tab))?.machine;
    if (remote) { chat.messages.push({ who: "claude", text: `Side chat works only for this machine's sessions, not ${remote}.`, error: true }); cx.notify(); return; }
    if (!pane) { chat.messages.push({ who: "claude", text: "No Claude session in this tab.", error: true }); cx.notify(); return; }
    this.busy.add(tab); cx.notify();
    cx.spawn(async (cx) => {
      try {
        // exec stops programs after 30 s and a forked answer can take longer: run ask.sh detached,
        // writing to a file, and wait for the file.
        const out = await this.run(cx, pane, chat.side ?? "-", q);
        if (out.session_id && !out.is_error) chat.side = out.session_id;
        chat.messages.push({ who: "claude", text: String(out.result ?? out.error ?? "No answer.").trim(), error: Boolean(out.is_error) });
      } catch (e) {
        chat.messages.push({ who: "claude", text: `Side chat failed: ${e.message ?? e}`, error: true });
      }
      this.busy.delete(tab); cx.notify();
    });
  }

  async run(cx, pane, side, q) {
    const file = `${home()}/.local/state/herdr-side-chat/${Date.now()}.json`;
    const script = `mkdir -p "$(dirname "$4")"; sh "$0" "$1" "$2" "$3" > "$4.part" 2>&1; mv "$4.part" "$4"`;
    await exec("sh", ["-c", `nohup sh -c '${script}' "$@" >/dev/null 2>&1 &`, "sh",
      `${appHome()}/mods/side-chat/ask.sh`, pane.terminal, side, q, file], { cwd: pane.cwd });
    // ponytail: polls the file twice a second; watchFolder if many side chats run at once.
    for (let waited = 0; waited < 300_000; waited += 500) {
      await cx.sleep(500);
      const text = await readTextFile(file);
      if (text != null) {
        exec("rm", ["-f", file]).catch(() => {});
        try { return JSON.parse(text); } catch { return { is_error: true, result: text.trim() || "No answer." }; }
      }
    }
    return { is_error: true, result: "No answer after 5 minutes." };
  }

  // Newest at the bottom, following new messages, like the chat mod: a scroll area starts at the
  // top and can't be moved from code, so the list hangs from the bottom of a clipped box and the
  // wheel moves it (scrollY = pixels up from the newest). A new message or "Thinking…" snaps back
  // to the bottom (2026-11-01).
  log(t, chat, bubble) {
    const busy = this.busy.has(this.tab), mark = `${this.tab}|${chat.messages.length}|${busy}`;
    if (mark !== this.mark) { this.mark = mark; this.scrollY = 0; }
    const max = Math.max(0, (this.contentH ?? 0) - (this.viewH ?? 0));
    if (this.scrollY > max) this.scrollY = max;
    return div().id("side-log").relative().flex_1().min_h(0).w_full().overflow_hidden()
      .on_size_change((size) => { this.viewH = size.height; })
      .on_scroll_wheel((e, cx) => {
        const top = Math.max(0, (this.contentH ?? 0) - (this.viewH ?? 0));
        const y = Math.min(top, Math.max(0, (this.scrollY ?? 0) + e.delta.y));
        if (y !== this.scrollY) { this.scrollY = y; cx.notify(); }
      })
      .child(v_flex().absolute().left(0).right(0).bottom(-(this.scrollY ?? 0)).p(14).gap(12)
        .on_size_change((size, cx) => { if (size.height !== this.contentH) { this.contentH = size.height; cx.notify(); } })
        .children(chat.messages.map(bubble))
        .when(busy, (el) => el.child(div().text_color(t.dim).child("Thinking…"))));
  }

  render() {
    if (!this.focused) { this.focused = true; this.input.focus(); }
    const t = theme(), chat = this.chat;
    // Selectable text (TextView), like the chat; answers render as markdown (2026-11-01). Code
    // blocks get a Copy button beside their language label.
    const text = (m, i) => {
      const parts = m.text.split(/(```[^\n]*\n[\s\S]*?```)/g).filter((x) => x.trim());
      if (parts.length < 2 && !parts[0]?.startsWith("```")) return TextView.markdown(`side-${this.tab}-${i}`, m.text).selectable(true);
      return v_flex().w_full().gap(4).children(parts.map((part, j) => {
        const id = `side-${this.tab}-${i}-${j}`, code = /^```[^\n]*\n([\s\S]*?)```$/.exec(part)?.[1];
        if (code == null) return TextView.markdown(id, part).selectable(true);
        return div().relative().w_full().child(TextView.markdown(id, part).selectable(true))
          .child(div().id(`${id}-copy`).absolute().top(10).right(64).px(8).py(2).rounded(5).text_size(11.5).cursor_pointer()
            .text_color(this.copied === id ? t.foreground : t.dim).bg(t.surface).hover((st) => st.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.write_to_clipboard(code.replace(/\n$/, "")); this.copied = id; cx.notify(); })
            .child(this.copied === id ? "Copied" : "Copy"));
      }));
    };
    const bubble = (m, i) => m.who === "you"
      ? h_flex().id(`m${i}`).w_full().justify_end().child(div().max_w("85%").px(12).py(8).rounded(12).bg(t.raised).child(text(m, i)))
      : div().id(`m${i}`).w_full().line_height("21px").text_color(m.error ? t.muted : t.foreground).child(text(m, i));
    return v_flex().size_full().bg(t.background).text_color(t.foreground).text_size(13)
      // Herdr's pane header already names it; a "New" link once there's a conversation.
      .when(chat.messages.length > 0, (el) => el.child(h_flex().h(28).px(12).items_center().justify_end().text_size(12)
        .child(div().id("side-new").cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          // A new object, so an answer still on its way lands in the old chat, not this one.
          .tooltip("New side chat").on_click((_e, cx) => { chats[this.tab] = { side: null, messages: [] }; cx.notify(); }).child("New"))))
      .child(chat.messages.length ? this.log(t, chat, bubble)
        : div().flex_1().flex().items_center().justify_center().text_color(t.muted).child("No messages yet"))
      .child(div().p(10).child(div().min_h(38).px(12).py(8).flex().items_center().rounded(10).border_1().border_color(t.input).bg(t.surface)
        .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        // The textarea fires no submit for Cmd+Enter, so the wrapper adds the line.
        .on_key_down((e, cx) => {
          if (e.key === "enter" && e.modifiers.platform && !e.modifiers.shift) { this.input.replace("\n"); cx.stop_propagation(); }
        })
        .child(Textarea.new(this.input).w_full().text_size(13).bg(t.surface).border(0).p(0))));
  }
}
