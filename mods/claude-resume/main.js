// Claude resume: after a reboot, start each Claude Code session again in the terminal it ran in
// (asked 2026-11-04, after a restart brought every Claude tab back as a bare shell).
//
// Herdr keeps terminals across a reboot but replaces the lost program with a new shell (hc keep).
// So while Claude runs, this labels its terminal claude.resume="<session id> <shell pid>". A
// terminal later found sitting at a shell with a different pid was restarted by Herdr, not exited
// by you (that leaves the same shell), so it gets `claude --dangerously-skip-permissions -r <id>`.
// The id is the transcript Claude is writing (the chat mod's find.sh), not ~/.claude/sessions'
// id, which goes stale after a resume.
// ponytail: this computer's terminals only; an ssh machine's would need exec/readTextFile { on }.

import { View, div } from "gpui-kit";
import { terminals, hc, exec, readTextFile, home, appHome } from "herdr";

const FINDER = `${appHome()}/mods/chat/find.sh`;
const LABEL = "claude.resume";
const isClaude = (t) => t.program?.key === "claude" || t.app === "claude-code" || /(^|\/)claude$/.test(t.foreground?.argv?.[0] ?? "");

export default class ClaudeResume extends View {
  init(_props, cx) {
    this.found = new Map(); // address -> { key, sid }: find.sh again only when Claude's pid or title changes
    const tick = () => {
      if (this.busy) return;
      this.busy = true;
      this.scan().catch((e) => console.log(`claude-resume: ${e?.message ?? e}`)).finally(() => { this.busy = false; });
    };
    tick();
    cx.timer.every(15000, tick);
  }

  async scan() {
    for (const t of terminals()) {
      if (t.address.includes("/") || t.state !== "live") continue;
      const fg = t.foreground ?? {}, saved = t.labels?.[LABEL];
      if (fg.pid && isClaude(t)) {
        const sid = await this.sessionOf(t);
        const want = `${sid} ${t.pid}`;
        if (sid && saved !== want) await hc(["label", t.address, `${LABEL}=${want}`]);
      } else if (saved && fg.pid === t.pid) {
        const [sid, shell] = saved.split(" ");
        if (String(t.pid) === shell) continue; // the same shell: you quit Claude yourself
        await hc(["label", t.address, `${LABEL}=${sid} ${t.pid}`]); // once, even if it fails to start
        await hc(["send", t.address, `claude --dangerously-skip-permissions -r ${sid}`]);
        console.log(`claude-resume: resumed ${sid} in ${t.address}`);
      }
    }
  }

  async sessionOf(t) {
    const pid = t.foreground.pid, title = String(t.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const key = `${pid}|${title}`, had = this.found.get(t.address);
    if (had?.key === key) return had.sid;
    const info = JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`)) ?? "null");
    const file = (await exec("sh", [FINDER, info?.cwd ?? t.foreground.cwd ?? t.cwd ?? "", title, info?.sessionId ?? ""])).stdout.trim();
    const sid = file ? file.split("/").pop().replace(/\.jsonl$/, "") : null; // none until the first message
    if (sid) this.found.set(t.address, { key, sid });
    return sid;
  }

  render(_cx) {
    return div().id("claude-resume");
  }
}
