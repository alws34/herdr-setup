// The task panel beside the board: a ClickUp task opened in place. Title, status, assignees, due
// date, priority, description, subtasks and comments all edit through the API (main.js's methods);
// only ↗ leaves for the browser. Also the small pieces cards and list rows share with it.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Textarea, TextView, Popup } from "gpui-base";
import { ago, dueLabel, monthName } from "./board.js";
import { openUrl } from "./open.js";

const URGENT = "#f50000";
export const PRIORITIES = [[1, "Urgent", URGENT], [2, "High", "#ffcc00"], [3, "Normal", "#6fddff"], [4, "Low", "#d8d8d8"]];
const PRIORITY_ICONS = { 2: "high", 3: "medium", 4: "low" };

// ClickUp's status mark: a ring while open, filled once closed.
export const statusDot = (color, closed, size = 10) =>
  div().size(size).flex_none().rounded_full().border_2().border_color(color).bg(closed ? color : "#00000000");

export const statusPill = (name, color, closed, t) =>
  h_flex().h(22).flex_none().px(8).gap(6).items_center().rounded(5).bg(t.raised).border_1().border_color(t.border)
    .text_size(10.5).font_semibold().child(statusDot(color, closed, 9)).child(name.toUpperCase());

export const priorityIcon = (priority, t) => priority === 1
  ? div().size(14).flex_none().flex().items_center().justify_center().rounded(3).bg(URGENT).text_size(10).font_bold().text_color("#ffffff").child("!")
  : svg(`mods/clickup-board/priority-${PRIORITY_ICONS[priority] ?? "none"}.svg`).size(14).flex_none().text_color(t.muted);

export const avatar = (p, size = 22) =>
  div().size(size).flex_none().flex().items_center().justify_center().rounded_full().bg(p.color)
    .text_size(size * 0.4).font_semibold().text_color("#ffffff").child(p.initials);

export function avatars(people, t, max = 3) {
  const out = [];
  for (let i = 0; i < people.length && i < max; i++) out.push(avatar(people[i]));
  if (people.length > max) out.push(div().text_size(11).text_color(t.dim).child(`+${people.length - max}`));
  return h_flex().flex_none().gap(2).items_center().children(out);
}

export function dueText(issue, t) {
  if (!issue.dueDate) return null;
  const due = dueLabel(issue.dueDate, issue.closed);
  return div().flex_none().text_size(11.5).text_color(due.overdue ? t.ansi1 : t.muted).child(due.text);
}

const button = (id, label, t, onClick, primary = false) =>
  h_flex().id(id).h(26).px(10).flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
    .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).border_1().border_color(t.border)
    .hover((s) => s.bg(primary ? t.solid : t.hover)).on_click(onClick).child(label);

export function taskPanel(v, t) {
  const s = v.selected, issue = s.issue;
  const list = v.cache.lists[issue.listId], members = v.cache.members[issue.listId] ?? [];
  const hover = (x) => x.bg(t.hover);

  // A trigger and, while `v.menu` names it, its options anchored under it. A press outside closes it.
  const menu = (name, trigger, options) => Popup.new(`menu-${name}`,
    h_flex().id(`trigger-${name}`).min_h(28).px(8).gap(6).items_center().rounded(6).cursor_pointer().hover(hover)
      .on_click((_e, cx) => { v.toggleMenu(name); cx.notify(); }).child(trigger))
    .anchor("bottom_left")
    .when(v.menu === name, (el) => el.content(v_flex().id(`menu-${name}-body`).min_w(220).max_h(340).p(4).gap(1)
      .overflow_y_scrollbar().rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(12.5)
      .on_mouse_down_out((_e, cx) => { v.closeMenu(); cx.notify(); }).children(options)));
  const option = (id, onPick, children, checked = false) =>
    h_flex().id(id).h(30).px(8).gap(8).items_center().rounded(5).cursor_pointer().hover(hover)
      .on_click((_e, cx) => { v.menu = null; onPick(cx); cx.notify(); })
      .children(children).child(div().flex_1()).child(div().text_color(t.accent).child(checked ? "✓" : ""));
  const prop = (label, value) => h_flex().min_h(34).gap(8).items_center()
    .child(div().w(92).flex_none().text_size(12).text_color(t.dim).child(label)).child(value);
  const heading = (text, extra = []) => h_flex().h(28).gap(8).items_center()
    .child(div().text_size(12).font_semibold().text_color(t.muted).child(text)).child(div().flex_1()).children(extra);

  // Status
  const statuses = list?.statuses ?? [{ name: issue.state, color: issue.statusColor, type: issue.closed ? "closed" : "open" }];
  const statusOptions = statuses.map((st, i) => option(`status-${i}`, (cx) => v.moveTo(issue, st, cx),
    [statusDot(st.color, st.type === "closed" || st.type === "done"), div().child(st.name.toUpperCase())], st.name.toLowerCase() === issue.state.toLowerCase()));

  // Assignees
  const assigned = new Set(issue.assignees.map((a) => a.id));
  const people = members.length ? members : issue.assignees;
  const assigneeOptions = people.map((m, i) => option(`member-${i}`, (cx) => v.toggleAssignee(issue, m, cx),
    [avatar(m, 20), div().child(m.username)], assigned.has(m.id)));

  // Priority
  const priorityOptions = PRIORITIES.map(([p, label], i) => option(`priority-${i}`, (cx) => v.setPriority(issue, p, cx),
    [priorityIcon(p, t), div().child(label)], issue.priority === p));
  priorityOptions.push(option("priority-clear", (cx) => v.setPriority(issue, 0, cx), [priorityIcon(0, t), div().text_color(t.muted).child("Clear")]));

  // Due date: a month grid from CalendarState, drawn here.
  const cal = v.calendar, chosen = cal.value(), today = cal.today(), weeks = cal.month_days()[0] ?? [];
  const month = `${cal.year()}-${String(cal.month()).padStart(2, "0")}`;
  const navButton = (id, label, step) => div().id(id).px(8).h(24).flex().items_center().rounded(5).cursor_pointer().hover(hover)
    .on_click((_e, cx) => { if (step < 0) cal.prev_month(); else cal.next_month(); cx.notify(); }).child(label);
  const calendar = [h_flex().h(30).px(4).items_center()
    .child(navButton("cal-prev", "‹", -1)).child(div().flex_1().text_center().font_semibold().child(`${monthName(cal.month())} ${cal.year()}`)).child(navButton("cal-next", "›", 1))];
  if (weeks.length) {
    calendar.push(h_flex().children(weeks[0].map((d) => div().w(32).text_center().text_size(10.5).text_color(t.dim).child("SMTWTFS"[new Date(`${d}T12:00`).getDay()]))));
  }
  for (const week of weeks) {
    calendar.push(h_flex().children(week.map((day) => div().id(`day-${day}`).w(32).h(28).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(day.startsWith(month) ? t.foreground : t.dim)
      .bg(day === chosen ? t.accent : "#00000000").border_1().border_color(day === today ? t.accent : "#00000000").hover(hover)
      .on_click((_e, cx) => { cal.set_value(day); v.menu = null; v.setDue(issue, day, cx); cx.notify(); })
      .child(String(Number(day.slice(8)))))));
  }
  calendar.push(h_flex().pt(4).gap(6).justify_end()
    .child(button("cal-today", "Today", t, (_e, cx) => { v.menu = null; v.setDue(issue, today, cx); cx.notify(); }))
    .child(button("cal-clear", "Clear", t, (_e, cx) => { v.menu = null; v.setDue(issue, null, cx); cx.notify(); })));

  // Description
  const description = v.editingDesc
    ? v_flex().gap(8)
      .child(div().rounded(6).border_1().border_color(t.accent).p(8).child(Textarea.new(v.desc).w_full().text_size(13)))
      .child(h_flex().gap(6).justify_end()
        .child(button("desc-cancel", "Cancel", t, (_e, cx) => { v.editingDesc = false; cx.notify(); }))
        .child(button("desc-save", "Save", t, (_e, cx) => v.saveDescription(cx), true)))
    : s.markdown === null
      ? div().text_color(t.dim).child("Loading…")
      : s.markdown.trim()
        ? div().id("desc-view").rounded(6).p(8).cursor_pointer().hover(hover).on_click((_e, cx) => v.editDescription(cx))
          .child(TextView.markdown(`desc-${issue.id}`, s.markdown).selectable(true))
        : div().id("desc-empty").rounded(6).p(8).text_color(t.dim).cursor_pointer().hover(hover)
          .on_click((_e, cx) => v.editDescription(cx)).child("Add a description…");

  // Subtasks
  const subtasks = s.subtasks.map((sub) => h_flex().id(`sub-${sub.id}`).h(32).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover(hover)
    .on_click((_e, cx) => { v.select(sub, cx); cx.notify(); })
    .child(statusDot(sub.statusColor, sub.closed)).child(div().flex_1().min_w(0).truncate().child(sub.title))
    .child(dueText(sub, t) ?? div()).child(avatars(sub.assignees, t)));
  subtasks.push(div().h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).child(Input.new(v.subtask).w_full().text_size(12.5)));

  // Comments
  const comments = s.comments === null ? [div().text_color(t.dim).child("Loading…")]
    : s.comments.map((c) => h_flex().gap(10).items_start()
      .child(avatar(c.user, 26))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(8).items_center().child(div().font_semibold().text_size(12.5).child(c.user.username))
          .child(div().text_size(11).text_color(t.dim).child(`${ago(c.date)} ago`)))
        .child(div().text_size(13).whitespace_normal().child(c.text))));

  const agent = v.onIssue.get(issue.identifier) ?? null;
  return v_flex().id("task-panel").w(560).flex_none().h_full().min_h(0).border_l(1).border_color(t.border).bg(t.background)
    .child(h_flex().h(46).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
      .child(div().min_w(0).truncate().child(list?.name ?? issue.project ?? ""))
      .child(div().flex_none().text_color(t.dim).child(issue.identifier))
      .child(div().flex_1())
      .child(button("panel-agent", agent ? `Agent: ${agent.status}` : "Agent", t, (_e, cx) => { if (agent) v.goToAgent(agent); else v.startAgent(issue); cx.notify(); }))
      .child(div().id("panel-web").px(8).h(26).flex().items_center().rounded(6).cursor_pointer().hover(hover)
        .on_click(() => openUrl(issue.url)).child("↗"))
      .child(div().id("panel-close").px(8).h(26).flex().items_center().rounded(6).cursor_pointer().hover(hover)
        .on_click((_e, cx) => { v.selected = null; v.menu = null; cx.notify(); }).child("✕")))
    .child(v_flex().id("task-panel-body").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).gap(14).text_size(13)
      .children(issue.parentId ? [div().id("panel-parent").text_size(12).text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground))
        .on_click((_e, cx) => { v.select({ ...issue, id: issue.parentId, title: issue.parent?.title ?? "" }, cx); cx.notify(); })
        .child(`↑ ${issue.parent?.title ?? "Parent task"}`)] : [])
      .child(div().rounded(6).px(6).py(4).border_1().border_color("#00000000").hover((x) => x.border_color(t.border))
        .child(Input.new(v.titleInput).w_full().text_size(19).font_semibold()))
      .child(v_flex().gap(2)
        .child(prop("Status", menu("status", statusPill(issue.state, issue.statusColor, issue.closed, t), statusOptions)))
        .child(prop("Assignees", menu("assignees", issue.assignees.length
          ? h_flex().gap(6).items_center().children(issue.assignees.map((a) => h_flex().gap(5).items_center().child(avatar(a, 20)).child(div().text_size(12).child(a.username))))
          : div().text_color(t.dim).child("Empty"), assigneeOptions)))
        .child(prop("Due date", menu("due", issue.dueDate ? dueText(issue, t) : div().text_color(t.dim).child("Empty"), calendar)))
        .child(prop("Priority", menu("priority", issue.priority
          ? h_flex().gap(6).items_center().child(priorityIcon(issue.priority, t)).child(PRIORITIES[issue.priority - 1][1])
          : div().text_color(t.dim).child("Empty"), priorityOptions))))
      .child(v_flex().gap(4).child(heading("Description", v.editingDesc || !s.markdown?.trim() ? []
        : [div().id("desc-edit").px(6).rounded(4).text_size(11.5).text_color(t.muted).cursor_pointer().hover(hover).on_click((_e, cx) => v.editDescription(cx)).child("Edit")]))
        .child(description))
      .child(v_flex().gap(4).child(heading(`Subtasks${s.subtasks.length ? ` · ${s.subtasks.length}` : ""}`)).children(subtasks))
      .child(v_flex().gap(10).child(heading("Comments")).children(comments)
        .child(v_flex().gap(6)
          .child(div().rounded(6).border_1().border_color(t.border).p(8).child(Textarea.new(v.comment).w_full().text_size(13)))
          .child(h_flex().justify_end().child(button("comment-send", "Comment", t, (_e, cx) => v.postComment(cx), true))))));
}
