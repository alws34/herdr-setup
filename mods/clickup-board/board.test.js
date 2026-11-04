// node --test ~/.config/herdr-app/mods/clickup-board/board.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardColumns, dayOf, dayToMs, dueLabel } from "./board.js";
import { toIssue } from "./sync.js";

const task = (id, status, type, priority = null) => toIssue({ id, name: id, date_created: "0", status: { status, type, color: "#123" }, priority: priority && { id: String(priority) }, list: { id: "L", name: "List" } });

test("a list's board keeps every status in the list's order, empty ones too", () => {
  const statuses = [{ name: "to do", type: "open", color: "#a" }, { name: "doing", type: "custom", color: "#b" }, { name: "done", type: "closed", color: "#c" }];
  const cols = boardColumns([task("a", "done", "closed"), task("b", "To Do", "open", 4), task("c", "to do", "open", 1)], statuses);
  assert.deepEqual(cols.map((c) => c.name), ["to do", "doing", "done"]);
  assert.deepEqual(cols[0].issues.map((i) => i.id), ["c", "b"]); // urgent first
  assert.equal(cols[1].issues.length, 0);
  assert.equal(cols[2].closed, true);
});

test("a status the list doesn't name still gets a column", () => {
  const cols = boardColumns([task("a", "stray", "custom")], [{ name: "to do", type: "open", color: "#a" }]);
  assert.deepEqual(cols.map((c) => c.name), ["to do", "stray"]);
});

test("My tasks orders columns by kind", () => {
  const cols = boardColumns([task("a", "in review", "custom"), task("b", "in progress", "custom"), task("c", "open", "open")]);
  assert.deepEqual(cols.map((c) => c.name), ["open", "in progress", "in review"]);
});

test("due dates round-trip through the calendar and label relative days", () => {
  const ms = dayToMs("2026-11-03");
  assert.equal(dayOf(ms), "2026-11-03");
  assert.deepEqual(dueLabel(ms, false, dayToMs("2026-11-03")), { text: "Today", overdue: false });
  assert.deepEqual(dueLabel(ms, false, dayToMs("2026-11-02")), { text: "Tomorrow", overdue: false });
  assert.deepEqual(dueLabel(ms, false, dayToMs("2026-11-05")), { text: "Nov 3", overdue: true });
  assert.equal(dueLabel(ms, true, dayToMs("2026-11-05")).overdue, false);
});
