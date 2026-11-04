// ClickUp, managed inside Herdr. A sidebar of your spaces, folders and lists (plus "My tasks": open
// tasks assigned to you everywhere) shows each as a Board (a column per status, empty ones too; drag a
// card onto another column to move it) or a List (rows grouped by status, closed groups folded). A
// click opens the task in a side panel (panel.js) that edits it through ClickUp's API; only its ↗
// opens the browser. `Agent` starts an agent on a task in a new worktree (clickup-board-agent).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, CalendarState } from "gpui-base";
import { agents, spaces, panes, focused, run, theme, home, appHome, props, readTextFile, nextCommand, openOverlay, shared, setShared, closeOverlay } from "herdr";
import * as cu from "./sync.js";
import { ago, boardColumns, dayOf, dayToMs, filterIssues, issueAgents, limitCards, projectsOf } from "./board.js";
import { avatars, dueText, priorityIcon, statusDot, statusPill, taskPanel } from "./panel.js";

const SYNC_MS = 5 * 60000;
const VIEW_KEY = "clickup-board.view";
const PROJECT_KEY = "clickup-board.project";
const AGENT_LABELS = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };
// A render has a time budget, and hundreds of cards overrun it. The rest stay behind the search.
const CARD_LIMIT = 80;
const ROW_LIMIT = 150;
// Fixed, so a filter that leaves few columns doesn't stretch the cards.
const COLUMN_WIDTH = 272;
const SIDEBAR_WIDTH = 236;
const SPINNER = "mods/clickup-board/spinner.svg";

// The focused pane's folder (else the focused terminal's, else the shown space's) and its machine.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

// Space › folder › list for a list id, for the header and to unfold the sidebar to it.
function pathTo(tree, listId) {
  for (const team of tree ?? []) for (const space of team.spaces) {
    for (const list of space.lists) if (list.id === listId) return { space, folder: null, list };
    for (const folder of space.folders) for (const list of folder.lists) if (list.id === listId) return { space, folder, list };
  }
  return null;
}

class ClickUp extends View {
  init(_props, cx) {
    // Pressing the key again opens a second copy: close both, so the key toggles the board.
    this.overlay = props()?.overlay ?? null;
    if (this.overlay && globalThis.__clickupBoardOpen) {
      this.toggledOff = true;
      closeOverlay(globalThis.__clickupBoardOpen);
      closeOverlay(this.overlay);
      // A reload can end the board without `close`: the mark mustn't outlive it and block every open.
      globalThis.__clickupBoardOpen = null;
      return;
    }
    globalThis.__clickupBoardOpen = this.overlay;
    // Tasks live for the app's run, not in shared state: every setShared redraws every mod.
    this.cache = globalThis.__clickupCache ??= { tree: null, data: {}, lists: {}, members: {} };
    this.view = { source: "mine", mode: "board", open: {}, ...(shared(VIEW_KEY) ?? {}) };
    this.project = shared(PROJECT_KEY) ?? null;
    this.text = ""; this.loading = {}; this.error = null; this.selected = null; this.menu = null; this.menuClosed = {};
    this.drag = null; this.over = null; this.adding = null; this.editingDesc = false; this.groups = {};

    this.search = InputState.new({ placeholder: "Search tasks" });
    this.search.on("change", (_e, cx) => { this.text = this.search.value(); cx.notify(); });
    this.newTask = InputState.new({ placeholder: "Task name, ⏎ to add" });
    this.newTask.on("submit", (_e, cx) => this.create(cx));
    this.titleInput = InputState.new({});
    this.titleInput.on("submit", (_e, cx) => this.saveTitle(cx));
    this.titleInput.on("blur", (_e, cx) => this.saveTitle(cx));
    this.subtask = InputState.new({ placeholder: "+ Add a subtask, ⏎" });
    this.subtask.on("submit", (_e, cx) => this.createSubtask(cx));
    this.desc = TextareaState.new({ rows: 10, placeholder: "Markdown" });
    this.comment = TextareaState.new({ rows: 3, placeholder: "Write a comment…" });
    this.calendar = CalendarState.new();

    cx.spawn(async (cx) => {
      try { await this.ready(); } catch (e) { this.error = String(e.message ?? e); }
      this.loadTree(cx);
      this.load(cx);
      cx.notify();
    });
    cx.timer.every(SYNC_MS, (cx) => this.load(cx, true));
    // A render that overruns its budget is dropped with no new render to follow: the view would stay
    // on its last version, which can be the loading state.
    cx.timer.every(1000, (cx) => { if (this.drawing) cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.load(cx, true);
        cx.notify();
      }
    });
  }

  close() {
    if (!this.toggledOff) globalThis.__clickupBoardOpen = null;
  }

  async ready() {
    if (!this.token) {
      const config = cu.parseConfig(await readTextFile(`${appHome()}/clickup-board.json`).catch(() => null), home());
      this.repos = config.repos; this.token = config.token;
    }
    if (!this.token) throw new Error("No ClickUp token: put {\"token\": \"pk_…\"} in ~/.config/herdr-app/clickup-board.json (ClickUp › Settings › Apps › API Token)");
    return this.token;
  }

  // Runs one API job; its error shows in the banner until the next success.
  act(cx, job) {
    cx.spawn(async (cx) => {
      try { await job(await this.ready(), cx); this.error = null; } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  setView(patch) {
    this.view = { ...this.view, ...patch };
    setShared(VIEW_KEY, this.view);
  }

  data() { return this.cache.data[this.view.source] ?? null; }

  loadTree(cx, force = false) {
    if (this.cache.tree && !force) return;
    this.act(cx, async (token) => { this.cache.tree = await cu.fetchTree(token); });
  }

  load(cx, force = false) {
    const source = this.view.source, held = this.cache.data[source];
    if (this.loading[source] || (!force && held && Date.now() - held.at < SYNC_MS)) return;
    this.loading[source] = true;
    cx.spawn(async (cx) => {
      try {
        const token = await this.ready();
        const data = source === "mine" ? await cu.fetchMine(token) : await cu.fetchList(token, source);
        this.cache.data[source] = { ...data, at: Date.now() };
        if (data.statuses) this.cache.lists[source] = { name: data.name, statuses: data.statuses };
        this.error = null;
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.loading[source] = false; cx.notify(); }
    });
    cx.notify();
  }

  openSource(source, cx) {
    this.setView({ source });
    this.adding = null; this.project = null;
    this.load(cx);
  }

  // Statuses and members of a task's list, for the panel's menus.
  ensureList(listId, cx) {
    if (!listId) return;
    if (!this.cache.lists[listId]) this.act(cx, async (token) => { this.cache.lists[listId] = await cu.fetchListInfo(token, listId); });
    if (!this.cache.members[listId]) this.act(cx, async (token) => { this.cache.members[listId] = await cu.fetchMembers(token, listId); });
  }

  select(issue, cx) {
    const id = issue.id;
    this.selected = { issue, markdown: null, subtasks: [], comments: null };
    this.titleInput.set_value(issue.title); this.editingDesc = false; this.menu = null;
    this.ensureList(issue.listId, cx);
    this.act(cx, async (token, cx) => {
      const [task, comments] = await Promise.all([cu.fetchTask(token, id), cu.fetchComments(token, id)]);
      if (this.selected?.issue.id !== id) return;
      if (this.titleInput.value() === this.selected.issue.title) this.titleInput.set_value(task.issue.title);
      this.selected = { ...this.selected, issue: { ...this.selected.issue, ...task.issue, workspace: issue.workspace, parent: issue.parent }, markdown: task.markdown, subtasks: task.subtasks, comments };
      this.ensureList(task.issue.listId, cx);
    });
  }

  // Applies a change to every copy of the task: each cached view, the panel and its subtasks.
  patch(id, fields) {
    for (const data of Object.values(this.cache.data)) {
      const i = data.issues.findIndex((x) => x.id === id);
      if (i >= 0) data.issues[i] = { ...data.issues[i], ...fields };
    }
    if (!this.selected) return;
    if (this.selected.issue.id === id) this.selected.issue = { ...this.selected.issue, ...fields };
    this.selected.subtasks = this.selected.subtasks.map((s) => (s.id === id ? { ...s, ...fields } : s));
  }

  // Shows the change at once, then keeps what ClickUp answers; a failure reloads the view.
  update(id, body, shown, cx) {
    this.patch(id, shown);
    this.act(cx, async (token, cx) => {
      try {
        const { workspace: _w, ...fresh } = await cu.updateTask(token, id, body);
        this.patch(id, fresh);
      } catch (e) { this.load(cx, true); throw e; }
    });
  }

  moveTo(issue, status, cx) {
    if (status.name.toLowerCase() === issue.state.toLowerCase()) return;
    const closed = status.closed ?? (status.type === "closed" || status.type === "done");
    this.update(issue.id, { status: status.name }, { state: status.name, statusColor: status.color, closed }, cx);
  }

  setPriority(issue, priority, cx) {
    this.update(issue.id, { priority: priority || null }, { priority }, cx);
  }

  setDue(issue, day, cx) {
    const ms = day ? dayToMs(day) : null;
    this.update(issue.id, ms ? { due_date: ms, due_date_time: false } : { due_date: null }, { dueDate: ms }, cx);
  }

  toggleAssignee(issue, member, cx) {
    const has = issue.assignees.some((a) => a.id === member.id);
    this.update(issue.id, { assignees: has ? { add: [], rem: [member.id] } : { add: [member.id], rem: [] } },
      { assignees: has ? issue.assignees.filter((a) => a.id !== member.id) : [...issue.assignees, member] }, cx);
  }

  saveTitle(cx) {
    const issue = this.selected?.issue, name = this.titleInput.value().trim();
    if (issue && name && name !== issue.title) this.update(issue.id, { name }, { title: name }, cx);
  }

  editDescription(cx) {
    this.desc.set_value(this.selected?.markdown ?? "");
    this.editingDesc = true;
    this.desc.focus();
    cx.notify();
  }

  saveDescription(cx) {
    const issue = this.selected?.issue, markdown = this.desc.value();
    if (!issue) return;
    this.selected.markdown = markdown; this.editingDesc = false;
    // ClickUp ignores an empty markdown_content, so clearing goes through the plain description.
    this.update(issue.id, markdown.trim() ? { markdown_content: markdown } : { description: "" }, {}, cx);
    cx.notify();
  }

  postComment(cx) {
    const id = this.selected?.issue.id, text = this.comment.value().trim();
    if (!id || !text) return;
    this.comment.set_value("");
    this.act(cx, async (token) => {
      await cu.addComment(token, id, text);
      const comments = await cu.fetchComments(token, id);
      if (this.selected?.issue.id === id) this.selected.comments = comments;
    });
  }

  create(cx) {
    const name = this.newTask.value().trim(), status = this.adding, listId = this.view.source;
    if (!name || listId === "mine") return;
    this.newTask.set_value("");
    this.act(cx, async (token) => {
      const issue = await cu.createTask(token, listId, status ? { name, status } : { name });
      this.cache.data[listId]?.issues.unshift({ ...issue, parent: null });
    });
  }

  createSubtask(cx) {
    const parent = this.selected?.issue, name = this.subtask.value().trim();
    if (!parent?.listId || !name) return;
    this.subtask.set_value("");
    this.act(cx, async (token) => {
      const sub = await cu.createTask(token, parent.listId, { name, parent: parent.id });
      if (this.selected?.issue.id === parent.id) this.selected.subtasks.push(sub);
    });
  }

  // A press outside an open menu closes it before the click on its trigger lands: without this
  // guard, that click would reopen it.
  toggleMenu(name) {
    if (this.menuClosed.name === name && Date.now() - this.menuClosed.at < 300) return;
    this.menu = this.menu === name ? null : name;
    const due = this.selected?.issue.dueDate;
    if (this.menu === "due") this.calendar.set_value(due ? dayOf(due) : null);
  }

  closeMenu() {
    this.menuClosed = { name: this.menu, at: Date.now() };
    this.menu = null;
  }

  // A list mapped in clickup-board.json works on that folder here; otherwise the space you're in.
  startAgent(issue) {
    const { cwd, on } = location(), mapped = this.repos?.[issue.team];
    openOverlay({ mod: "clickup-board-agent", kind: "dialog", width: 480, height: 660,
      props: { issue, cwd: mapped ?? cwd, on: mapped ? null : on, board: this.overlay } });
  }

  goToAgent(agent) {
    run("space.select", { id: agent.space });
    run("tab.select", { id: agent.tab });
    run("pane.focus", { pane: agent.pane });
    closeOverlay(this.overlay);
  }

  sidebar(t, hover, path) {
    const rows = [], source = this.view.source;
    const row = (id, depth, active, onClick, children) => h_flex().id(id).h(28).flex_none().pl(8 + depth * 14).pr(8).gap(7).items_center()
      .rounded(6).cursor_pointer().text_size(12.5).bg(active ? t.selected : "#00000000").text_color(active ? t.foreground : t.muted)
      .hover(hover).on_click(onClick).children(children);
    const isOpen = (id, onPath) => this.view.open[id] ?? onPath;
    const toggle = (id, onPath) => (_e, cx) => { this.setView({ open: { ...this.view.open, [id]: !isOpen(id, onPath) } }); cx.notify(); };
    const listRow = (list, depth) => row(`list-${list.id}`, depth, source === list.id, (_e, cx) => { this.openSource(list.id, cx); cx.notify(); },
      [div().text_color(t.dim).child("≡"), div().min_w(0).truncate().child(list.name)]);

    rows.push(row("mine", 0, source === "mine", (_e, cx) => { this.openSource("mine", cx); cx.notify(); },
      [div().text_color(t.accent).child("●"), div().child("My tasks")]));
    const tree = this.cache.tree;
    if (!tree) rows.push(div().px(10).py(6).text_size(12).text_color(t.dim).child("Loading spaces…"));
    for (const team of tree ?? []) {
      rows.push(div().px(10).pt(14).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child(team.name.toUpperCase()));
      for (const space of team.spaces) {
        const open = isOpen(space.id, path?.space === space);
        rows.push(row(`space-${space.id}`, 0, false, toggle(space.id, path?.space === space),
          [div().w(10).text_color(t.dim).child(open ? "▾" : "▸"), div().size(14).flex_none().rounded(4).bg(space.color ?? t.accent)
            .flex().items_center().justify_center().text_size(9).font_bold().text_color("#ffffff").child(space.name.slice(0, 1).toUpperCase()),
          div().min_w(0).truncate().text_color(t.foreground).child(space.name)]));
        if (!open) continue;
        for (const folder of space.folders) {
          const fopen = isOpen(folder.id, path?.folder === folder);
          rows.push(row(`folder-${folder.id}`, 1, false, toggle(folder.id, path?.folder === folder),
            [div().w(10).text_color(t.dim).child(fopen ? "▾" : "▸"), div().min_w(0).truncate().child(folder.name)]));
          if (fopen) for (const list of folder.lists) rows.push(listRow(list, 2));
        }
        for (const list of space.lists) rows.push(listRow(list, 1));
      }
    }
    return v_flex().id("sidebar").w(SIDEBAR_WIDTH).flex_none().h_full().min_h(0).p(6).gap(1).overflow_y_scrollbar()
      .border_r(1).border_color(t.border).bg(t.chrome).children(rows);
  }

  newTaskBox(t) {
    return div().h(32).flex_none().px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
      .child(Input.new(this.newTask).w_full().text_size(12.5));
  }

  addButton(column, t, hover) {
    return div().id(`add-${column.name}`).px(6).h(22).flex().items_center().rounded(5).cursor_pointer().text_color(t.dim).hover(hover)
      .on_click((_e, cx) => { this.adding = this.adding === column.name ? null : column.name; if (this.adding) this.newTask.focus(); cx.notify(); })
      .child("+");
  }

  card(issue, agent, t, hover, buttonHover) {
    const status = agent ? t[agent.status] : null, chosen = this.selected?.issue.id === issue.id;
    const parent = issue.parent ? issue.parent.title ?? issue.parent.identifier : null;
    const labels = [];
    for (let i = 0; i < issue.labels.length && i < 3; i++) {
      labels.push(h_flex().h(20).flex_none().items_center().rounded_full().border_1().border_color(t.border).px(7).gap(5).text_size(10.5).text_color(t.muted)
        .child(div().size(7).rounded_full().bg(issue.labels[i].color)).child(issue.labels[i].name));
    }
    return v_flex().id(`card-${issue.id}`).flex_none().w_full().px(12).py(10).gap(8).rounded(8).cursor_grab()
      .bg(t.raised).border_1().border_color(chosen ? t.accent : status ?? t.border).hover(hover)
      .opacity(this.drag?.id === issue.id && this.over && this.over !== issue.state ? 0.5 : 1)
      .on_mouse_down("left", (_e, cx) => { this.drag = issue; this.over = null; cx.notify(); })
      .on_click((_e, cx) => { this.drag = null; this.select(issue, cx); cx.notify(); })
      .children(parent ? [div().text_size(11).text_color(t.dim).truncate().child(`↑ ${parent}`)] : [])
      .child(h_flex().gap(7).items_start()
        .child(div().pt(3).child(statusDot(issue.statusColor, issue.closed)))
        .child(div().flex_1().min_w(0).text_size(13).child(issue.title)))
      .children(labels.length ? [h_flex().gap(4).overflow_hidden().children(labels)] : [])
      .child(h_flex().h(22).gap(8).items_center()
        .child(avatars(issue.assignees, t))
        .child(dueText(issue, t) ?? div())
        .child(issue.priority ? priorityIcon(issue.priority, t) : div())
        .child(div().flex_1())
        .child(div().id(`agent-${issue.id}`).px(7).h(20).flex().gap(5).items_center().rounded(5).cursor_pointer()
          .text_size(10.5).text_color(agent ? status : t.dim).border_1().border_color(agent ? status : t.border).hover(buttonHover)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); if (agent) this.goToAgent(agent); else this.startAgent(issue); })
          .children(agent?.status === "working" ? [svg(SPINNER).size(10).flex_none().text_color(status).spin(900)] : agent ? [div().size(6).flex_none().rounded_full().bg(status)] : [])
          .child(agent ? AGENT_LABELS[agent.status] : "Agent")));
  }

  board(columns, onIssue, t, hover, buttonHover, canAdd) {
    const lanes = [];
    for (const column of columns) {
      const cards = [], hidden = column.issues.length - column.shown.length;
      const target = this.drag && this.over === column.name && this.drag.state.toLowerCase() !== column.name.toLowerCase();
      if (this.adding === column.name) cards.push(this.newTaskBox(t));
      for (const issue of column.shown) cards.push(this.card(issue, onIssue.get(issue.identifier), t, hover, buttonHover));
      if (hidden > 0) cards.push(div().flex_none().px(4).py(6).text_size(11).text_color(t.dim).child(`${hidden} more: search to see them`));
      lanes.push(v_flex().id(`lane-${column.name}`).h_full().w(COLUMN_WIDTH).flex_none().min_h(0).p(6).gap(6).rounded(10)
        .bg(target ? t.hover : t.surface).border_1().border_color(target ? t.accent : t.border)
        .on_mouse_move((_e, cx) => { if (this.drag && this.over !== column.name) { this.over = column.name; cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.moveTo(this.drag, column, cx); this.drag = null; this.over = null; cx.notify(); } })
        .child(h_flex().h(30).flex_none().px(4).gap(8).items_center()
          .child(statusPill(column.name, column.color, column.closed, t))
          .child(div().text_size(12).text_color(t.dim).child(String(column.issues.length)))
          .child(div().flex_1())
          .children(canAdd ? [this.addButton(column, t, hover)] : []))
        .child(v_flex().id(`column-${column.name}`).flex_1().min_h(0).gap(8).pb(4).overflow_y_scrollbar().children(cards)));
    }
    return h_flex().id("board").flex_1().min_h(0).p(12).gap(10).items_start().overflow_x_scrollbar().children(lanes);
  }

  list(columns, t, hover, canAdd) {
    const rows = [h_flex().h(30).flex_none().px(14).gap(10).items_center().text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
      .child(div().flex_1().child("Name")).child(div().w(110).child("Assignee")).child(div().w(84).child("Due date")).child(div().w(30).child("Pri."))];
    for (const column of columns) {
      const folded = this.groups[column.name] ?? column.closed, hidden = column.issues.length - column.shown.length;
      rows.push(h_flex().id(`group-${column.name}`).h(38).flex_none().px(10).pt(8).gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.groups[column.name] = !folded; cx.notify(); })
        .child(div().w(12).text_color(t.dim).child(folded ? "▸" : "▾"))
        .child(statusPill(column.name, column.color, column.closed, t))
        .child(div().text_size(12).text_color(t.dim).child(String(column.issues.length)))
        .child(div().flex_1())
        .children(canAdd ? [this.addButton(column, t, hover)] : []));
      if (folded) continue;
      if (this.adding === column.name) rows.push(div().px(14).py(4).child(this.newTaskBox(t)));
      for (const issue of column.shown) {
        const chosen = this.selected?.issue.id === issue.id;
        const parent = issue.parent ? issue.parent.title ?? issue.parent.identifier : null;
        rows.push(h_flex().id(`row-${issue.id}`).h(36).flex_none().px(14).gap(10).items_center().cursor_pointer()
          .border_b(1).border_color(t.border).bg(chosen ? t.selected : "#00000000").hover(hover)
          .on_click((_e, cx) => { this.select(issue, cx); cx.notify(); })
          .child(h_flex().flex_1().min_w(0).gap(8).items_center()
            .child(statusDot(issue.statusColor, issue.closed))
            .child(div().min_w(0).truncate().text_size(13).child(issue.title))
            .children(parent ? [div().flex_none().max_w(200).truncate().text_size(11).text_color(t.dim).child(`↑ ${parent}`)] : []))
          .child(div().w(110).flex_none().child(avatars(issue.assignees, t)))
          .child(div().w(84).flex_none().child(dueText(issue, t) ?? div()))
          .child(div().w(30).flex_none().child(issue.priority ? priorityIcon(issue.priority, t) : div())));
      }
      if (hidden > 0) rows.push(div().px(14).py(6).text_size(11).text_color(t.dim).child(`${hidden} more: search to see them`));
    }
    return v_flex().id("list").flex_1().min_h(0).pb(16).overflow_y_scrollbar().children(rows);
  }

  render() {
    if (this.toggledOff) return div();
    this.drawing = true;
    const t = theme(), data = this.data(), issues = data?.issues ?? [], source = this.view.source;
    const loading = this.loading[source], waiting = !data && !this.error;
    const mine = source === "mine", path = mine ? null : pathTo(this.cache.tree, source);
    const projects = mine ? projectsOf(issues) : [];
    // A sync can take the chosen project away.
    let project = null;
    for (const p of projects) if (p.name === this.project) project = p.name;
    const boardMode = this.view.mode === "board";
    const columns = limitCards(boardColumns(filterIssues(issues, this.text, project), data?.statuses), boardMode ? CARD_LIMIT : ROW_LIMIT);
    const hover = (s) => s.bg(t.hover), buttonHover = (s) => s.bg(t.background).text_color(t.foreground);
    const branches = new Map();
    for (const pane of panes()) branches.set(pane.pane, pane.branch);
    // Kept for the task panel, drawn below.
    const onIssue = this.onIssue = issueAgents(agents(), branches);

    const chips = [];
    for (let i = -1; i < projects.length; i++) {
      const name = i < 0 ? "All" : projects[i].name, target = i < 0 ? null : name, active = project === target;
      chips.push(h_flex().id(`project-${i}`).h(26).px(9).gap(6).flex_none().max_w(320).items_center().rounded(7).cursor_pointer().text_size(11.5)
        .bg(active ? t.selected : t.raised).text_color(active ? t.foreground : t.muted).hover(hover)
        .on_click((_e, cx) => { this.project = target; setShared(PROJECT_KEY, target); cx.notify(); })
        .child(div().min_w(0).truncate().child(name))
        .child(div().flex_none().text_color(t.dim).child(String(i < 0 ? issues.length : projects[i].count))));
    }
    const tab = (mode, label) => div().id(`mode-${mode}`).px(10).h(24).flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .bg(this.view.mode === mode ? t.selected : "#00000000").text_color(this.view.mode === mode ? t.foreground : t.muted)
      .on_click((_e, cx) => { this.setView({ mode }); cx.notify(); }).child(label);
    const title = mine ? "My tasks" : path ? [path.space.name, path.folder?.name, path.list.name].filter(Boolean).join(" › ") : data?.name ?? "List";

    const main = v_flex().flex_1().h_full().min_w(0).min_h(0)
      .child(h_flex().h(46).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().font_semibold().child(title))
        .children(data ? [div().flex_none().text_size(11).text_color(t.dim).child(`${issues.length} tasks · synced ${ago(data.at)} ago`)] : [])
        .child(div().flex_1())
        .child(h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.raised).child(tab("board", "Board")).child(tab("list", "List")))
        .child(div().w(200).flex_none().h(26).px(8).flex().items_center().rounded(7).border_1()
          .border_color(this.text.trim() ? t.accent : t.border).bg(t.background)
          .child(Input.new(this.search).h_full().text_size(11.5).text_color(t.foreground)))
        .children(mine ? [] : [div().id("new-task").px(10).h(26).flex().items_center().rounded(7).cursor_pointer().text_size(12)
          .bg(t.solid).text_color(t.solid_foreground)
          .on_click((_e, cx) => { this.adding = columns[0]?.name ?? null; this.groups[this.adding] = false; this.newTask.focus(); cx.notify(); }).child("+ Task")])
        .child(div().id("refresh").px(8).h(26).flex().items_center().rounded(7).cursor_pointer().text_size(11.5).text_color(t.muted)
          .hover(hover).on_click((_e, cx) => { this.load(cx, true); this.loadTree(cx, true); })
          .child(loading ? svg(SPINNER).size(13).flex_none().text_color(t.muted).spin(900) : "Refresh")))
      .children(projects.length > 1 ? [h_flex().flex_none().flex_wrap().px(14).py(8).gap(6).items_center().border_b(1).border_color(t.border).children(chips)] : [])
      .children(this.error ? [h_flex().id("error").flex_none().px(14).py(6).gap(8).text_size(11.5).text_color(t.ansi1)
        .child(div().flex_1().min_w(0).child(this.error))
        .child(div().id("error-close").cursor_pointer().on_click((_e, cx) => { this.error = null; cx.notify(); }).child("✕"))] : [])
      .children(waiting || (loading && !data) ? [h_flex().flex_1().min_h(0).gap(10).items_center().justify_center().text_color(t.dim)
        .child(svg(SPINNER).size(18).flex_none().text_color(t.muted).spin(900)).child("Loading tasks…")] : [])
      .children(data && !columns.length ? [div().p(16).text_color(t.dim).child(issues.length ? "No tasks match this search" : mine ? "No open tasks assigned to you" : "No tasks in this list yet")] : [])
      .children(data && columns.length ? [boardMode ? this.board(columns, onIssue, t, hover, buttonHover, !mine) : this.list(columns, t, hover, !mine)] : []);

    const tree = h_flex().id("clickup-board").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .when(Boolean(this.drag), (el) => el.cursor_grabbing())
      .on_mouse_up("left", (_e, cx) => { if (this.drag) { this.drag = null; this.over = null; cx.notify(); } })
      .child(this.sidebar(t, hover, path))
      .child(main)
      .children(this.selected ? [taskPanel(this, t)] : []);
    this.drawing = false;
    return tree;
  }
}

// Every open evaluates this module again, and the app's JIT does slow bookkeeping as fresh code warms
// up: the window froze for seconds on each open. Reusing the view from the first open keeps its code
// warm. The source is compared so a changed mod still takes effect.
const source = [ClickUp, cu.fetchList, cu.fetchMine, cu.toIssue, boardColumns, filterIssues, limitCards, projectsOf, taskPanel].map(String).join();
if (globalThis.__clickupBoard?.source !== source) globalThis.__clickupBoard = { source, view: ClickUp };
export default globalThis.__clickupBoard.view;
