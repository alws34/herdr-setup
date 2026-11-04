// Self-check for main.js's pure helpers (parsePrompt, segments): `node check.mjs`.
// The screens are real Claude Code prompts captured with `hc read`.
import fs from "fs";
const src = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");
const grab = (name) => src.match(new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\n}\\n`))[0].replace(/^export /, "");
const { parsePrompt, segments, linkFiles, matchCommands, plainMd, isRtl, startsRtl, rtlBlocks, rtlRuns, taskList, boxText, stuckIn, textRoles } = new Function(`${grab("textRoles")}\n${grab("boxText")}\n${grab("stuckIn")}\n${grab("taskList")}\n${grab("parsePrompt")}\n${grab("segments")}\n${grab("linkFiles")}\n${grab("matchCommands")}\n${grab("plainMd")}\n${grab("isRtl")}\n${grab("startsRtl")}\n${grab("rtlBlocks")}\n${grab("rtlRuns")}\nreturn { parsePrompt, segments, linkFiles, matchCommands, plainMd, isRtl, startsRtl, rtlBlocks, rtlRuns, taskList, boxText, stuckIn, textRoles };`)();
const SCREEN1 = `⏺ Bash(mkdir -p /tmp/herdr-chat-test/sub && echo hi > /tmp/herdr-chat-test/sub/a.txt)\n  ⎿  Waiting…\n\n────────────────────────────────────────────────────────────────────────────────────────\n Bash command\n Tip: auto mode handles these prompts for you — choose "switch to auto mode" below\n Create sub directory and write hi to a.txt\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n mkdir -p /tmp/herdr-chat-test/sub && echo hi > /tmp/herdr-chat-test/sub/a.txt\n╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for mkdir commands\n   3. Yes, and switch to auto mode · auto mode handles these prompts for you\n   4. No\n\n Esc to cancel · Tab to amend\n`;
const SCREEN2 = `────────────────────────────────────────────────────────────────────────────────────────\n Accessing workspace:\n\n /private/tmp/herdr-chat-test\n\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`;
const assert = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } };
const p1 = parsePrompt(SCREEN1);
assert(p1.options.length === 4 && p1.options[0].keys.join() === "enter" && p1.options[2].keys.join() === "down,down,enter" && p1.options[3].label === "No", JSON.stringify(p1));
assert(p1.question === "Do you want to proceed?" && p1.title === "Bash command", JSON.stringify(p1));
const p2 = parsePrompt(SCREEN2);
assert(p2.options.length === 2 && p2.options[1].keys.join() === "down,enter" && p2.options[0].keys.join() === "enter", JSON.stringify(p2));
assert(parsePrompt("just text\n────────────────────────\n❯ \n") === null, "no prompt");
const seg = segments("Hi\n\n```py\nx = 1\n```\nafter");
assert(seg.length === 3 && seg[1].code === "x = 1" && seg[1].lang === "py" && seg[2].md.trim() === "after", JSON.stringify(seg));
const Q1 = `❯ Call the AskUserQuestion tool exactly once.\n────────────────────────────────────────────────────────────\n←  ☒ Mac  ☐ GPU  ✔ Submit  →\n\nWhich Mac items to delete?\n\n  1. [✔] Epoch checkpoints\n         Delete epoch checkpoint files\n  2. [ ] Old images\n         Delete old image files\n❯ 3. [✔] Scratch files\n         Delete scratch files\n  4. [ ] Type something\n     Next\n────────────────────────────────────────────────────────────\n  5. Chat about this\n\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel`;
const Q2 = `────────────────────────────────────────────────────────────\n←  ☒ Mac  ☐ GPU  ✔ Submit  →\n\nWhich GPU box?\n\n❯ 1. 3090\n     Select the 3090 GPU box\n  2. A100\n     Select the A100 GPU box\n  3. Type something.\n────────────────────────────────────────────────────────────\n  4. Chat about this\n\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel`;
const Q3 = `────────────────────────────────────────────────────────────\n←  ☒ Mac  ☒ GPU  ✔ Submit  →\n\nReview your answers\n\n ● Which GPU box?\n   → A100\n\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel`;
const a = parsePrompt(Q1);
assert(a.kind === "question" && a.multi && a.question === "Which Mac items to delete?" && a.tabs.map((x) => x.label + x.done).join() === "Mactrue,GPUfalse,Submittrue", JSON.stringify(a));
assert(a.options.map((o) => o.label).join() === "Epoch checkpoints,Old images,Scratch files,Next" && a.options[0].checked && !a.options[1].checked, JSON.stringify(a.options));
assert(a.options[0].keys.join() === "up,up,enter" && a.options[3].keys.join() === "down,down,enter" && a.chat.join() === "down,down,down,enter", JSON.stringify(a));
assert(a.options[0].desc === "Delete epoch checkpoint files", a.options[0].desc);
const b = parsePrompt(Q2);
assert(b.kind === "question" && !b.multi && b.options.length === 2 && b.options[1].keys.join() === "down,enter" && b.chat.join() === "down,down,down,enter", JSON.stringify(b));
const c = parsePrompt(Q3);
assert(c.question === "Ready to submit your answers?" && c.title === "Review your answers" && c.options[0].label === "Submit answers", JSON.stringify(c));
const NAMED = "\n" + "─".repeat(62) + " clickup-kanban-list-in-app ─\n";
const cn = parsePrompt(Q3 + NAMED);
assert(cn && cn.question === "Ready to submit your answers?" && cn.options.map((o) => o.label).join() === "Submit answers,Cancel", "review in a named session: " + JSON.stringify(cn));
const pn = parsePrompt(SCREEN1 + NAMED);
assert(pn && pn.options.length === 4 && pn.question === "Do you want to proceed?", "permission prompt in a named session: " + JSON.stringify(pn));
const an = parsePrompt(Q1 + NAMED);
assert(an.kind === "question" && an.options.length === 4, "question in a named session");
const lf = linkFiles("see `mods/chat/main.js`, `~/x/y.md:12`, `README.md`, `v2.1.3`, `1.5`, `npm test`, `https://a.b/c.js`");
assert(lf.includes("[mods/chat/main.js](hfile:mods%2Fchat%2Fmain.js)") && lf.includes("[~/x/y.md:12](hfile:") && lf.includes("[README.md](hfile:README.md)"), lf);
assert(lf.includes("`v2.1.3`") && lf.includes("`1.5`") && lf.includes("`npm test`") && lf.includes("`https://a.b/c.js`"), lf);
const cl = [{ name: "clear", desc: "Clear it" }, { name: "superpowers:brainstorming", desc: "Before creative work" }, { name: "ponytail:ponytail-review", desc: "Review" }, { name: "code-review", desc: "Review the diff" }];
assert(matchCommands(cl, "").length === 4, "empty query lists all");
assert(matchCommands(cl, "br")[0].name === "superpowers:brainstorming", "prefix after plugin:");
assert(matchCommands(cl, "rev").map((c) => c.name).join() === "ponytail:ponytail-review,code-review", "contains, in list order");
assert(matchCommands(cl, "creative")[0].name === "superpowers:brainstorming" && !matchCommands(cl, "zzz").length, "description / none");
const rb = rtlBlocks("רשמתי: פספוס עדיף.\nשורה שנייה\n\n1. משקל גבוה ל-`other`\n   המשך\n2. Plain English item\n\n| a | b |\n|---|---|\n\n## כותרת");
assert(rb.map((b) => `${b.kind}:${b.rtl}`).join() === "p:true,li:true,li:false,raw:false,h:true", JSON.stringify(rb));
assert(rb[0].text === "רשמתי: פספוס עדיף. שורה שנייה" && rb[1].text.endsWith("המשך") && rb[1].marker === "1.", JSON.stringify(rb[1]));
assert(startsRtl("`code` שלום") && !startsRtl("[שלום](http://x) hello") === false && !startsRtl("hello שלום"), "first letter decides");
const rr = rtlRuns("הנדירות (petri ×2.41, EM ×1.73). זה **מלמד** את ה-`loss`");
const flat = rr.map((r) => (r.rtl ? "R:" : "L:") + r.words.map((w) => w.map((p) => p.t).join("")).join(" "));
assert(flat.join("|") === "R:הנדירות|L:(petri ×2.41, EM ×1.73)|R:.|R:זה|R:מלמד|R:את|R:ה-loss", flat.join("|"));
assert(rr[4].words[0][0].b && rr[6].words[0][1].code, "bold and code kept");
assert(plainMd("a *b* `c` <d> & 1.\n  two  sp\n") === "a \\*b\\* \\`c\\` \\<d\\> \\& 1\\.\\\n&nbsp;&nbsp;two&nbsp;&nbsp;sp\\\n&nbsp;", plainMd("a *b* `c` <d> & 1.\n  two  sp\n"));
console.log("ok", JSON.stringify(p1), JSON.stringify(p2));

// taskList: task files sorted by id, deleted ones out; else the newest TodoWrite list.
const tl = taskList([{ id: "10", subject: "c", status: "pending" }, { id: "2", subject: "b", status: "in_progress", activeForm: "Doing b" }, { id: "3", subject: "x", status: "deleted" }], []);
assert(tl.map((x) => x.text).join() === "b,c" && tl[0].active === "Doing b", JSON.stringify(tl));
const tw = taskList([], [{ name: "TodoWrite", in: { todos: [{ content: "old", status: "pending" }] } }, { name: "Bash", in: {} }, { name: "TodoWrite", in: { todos: [{ content: "a", status: "completed", activeForm: "A-ing" }] } }]);
assert(tw.length === 1 && tw[0].text === "a" && tw[0].status === "completed", JSON.stringify(tw));
assert(taskList(undefined, []).length === 0, "empty");
console.log("taskList ok");

// boxText / stuckIn: the text left in Claude Code's box after a dropped Enter.
const BOX = "● Done.\n\n" + "─".repeat(40) + " name ─\n❯ @/Users/a/x.png\n  right clicking on a space\n" + "─".repeat(50) + "\n  ⏵⏵ bypass permissions on\n";
assert(boxText(BOX) === "@/Users/a/x.png right clicking on a space", boxText(BOX));
assert(stuckIn(boxText(BOX), "@/Users/a/x.png\nright clicking on a space"), "stuck");
assert(!stuckIn(boxText("─".repeat(40) + "\n❯ \n" + "─".repeat(40) + "\n"), "hello there"), "empty box");
assert(!stuckIn("Try \"fix lint errors\"", "hello there"), "suggestion isn't ours");
console.log("boxText ok");

// textRoles: narration before a tool call (and thinking updates) is interim; a turn's last text is
// final, the last turn's is "live" (interim while Claude works).
const tr = textRoles([{ k: "user" }, { k: "text" }, { k: "tool" }, { k: "text", think: true }, { k: "text" }, { k: "user" },
  { k: "text" }, { k: "tool" }, { k: "res" }, { k: "text" }]);
assert(tr.join() === ",interim,,interim,final,,interim,,,live", tr.join());
assert(textRoles([{ k: "text" }, { k: "tool" }, { k: "user" }]).join() === "interim", "a turn with no closing text");
console.log("textRoles ok");
