// Docker sbx sandboxes: lists `sbx ls`, and opens a sandbox's session (the
// existing one, else a new terminal running it).
//
// A session is a terminal labelled `sbx.sandbox=<name>`. Terminals this mod
// starts get the label once they run `sbx`; terminals started by hand are
// adopted when their foreground program is `sbx` in the sandbox's workspace.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, terminals, panes, spaces, run, theme, layout, notify, pickFolder, checking } from "herdr";

const ICON = (n) => `mods/workspace-chrome/${n}.svg`;
const LABEL = "sbx.sandbox";
const POLL_MS = 5000;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The first writable workspace is the project; an `sbxenv.yaml:ro` mount means
// the sandbox is declared by that file and is started with `sbx env run`.
function describe(s) {
  const mounts = s.workspaces ?? [];
  const folder = mounts.find((w) => !w.endsWith(":ro")) ?? mounts[0]?.replace(/:ro$/, "") ?? "";
  const env = mounts.some((w) => /\/sbxenv\.yaml(:ro)?$/.test(w));
  return { ...s, folder, env };
}

// Which sandbox a running `sbx ...` command belongs to, when several share a folder:
// one it names (`--name x`, `exec -it x`), else an sbxenv one for `sbx env`,
// else a running one, else the most recently used.
function pick(candidates, fg, all) {
  const named = all.find((x) => fg.includes(x.name));
  if (named) return named;
  let pool = candidates;
  if (!pool.length) return null;
  if (fg[1] === "env") pool = pool.filter((x) => x.env).length ? pool.filter((x) => x.env) : pool;
  const running = pool.filter((x) => x.status === "running");
  if (running.length) pool = running;
  return [...pool].sort((a, b) => Date.parse(b.last_used_at ?? 0) - Date.parse(a.last_used_at ?? 0))[0];
}

const startArgv = (s) => (s.env ? ["sbx", "env", "run", s.folder] : ["sbx", "run", "--name", s.name]);
const shellArgv = (s) => ["sbx", "exec", "-it", s.name, "bash"];

// Resource usage, read inside the sandbox's VM. Only ever for running sandboxes:
// `sbx exec` starts a stopped one.
const STATS_MS = 10000;
const STATS_SH = "head -1 /proc/stat; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; df -kP / | tail -1; nproc";

function parseStats(out) {
  const lines = out.trim().split("\n");
  const cpu = lines.find((l) => l.startsWith("cpu "))?.trim().split(/\s+/).slice(1).map(Number) ?? [];
  const kb = (k) => Number(lines.find((l) => l.startsWith(k))?.match(/(\d+)/)?.[1] ?? NaN) * 1024;
  const df = lines.find((l) => l.endsWith(" /"))?.trim().split(/\s+/) ?? [];
  const idle = (cpu[3] ?? 0) + (cpu[4] ?? 0);
  const total = cpu.slice(0, 8).reduce((a, b) => a + b, 0);
  return {
    idle, total,
    memTotal: kb("MemTotal:"), memUsed: kb("MemTotal:") - kb("MemAvailable:"),
    diskSize: Number(df[1]) * 1024, diskUsed: Number(df[2]) * 1024,
    cpus: Number(lines.at(-1)),
  };
}

function bytes(n) {
  if (!Number.isFinite(n)) return "?";
  const g = n / 2 ** 30;
  return g >= 10 ? `${g.toFixed(0)}G` : g >= 1 ? `${g.toFixed(1)}G` : `${Math.round(n / 2 ** 20)}M`;
}

export default class Sandboxes extends View {
  init(_props, cx) {
    this.list = [];
    this.error = null;
    this.loaded = false;
    this.busy = new Set(); // sandbox names with a stop in flight
    this.checked = new Map(); // terminal address -> when it was last asked (ms)
    this.stats = new Map(); // sandbox name -> { cpu (0..100), memUsed, memTotal, diskUsed, diskSize, cpus, raw }
    if (checking()) return;
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
    cx.timer.every(STATS_MS, (cx) => this.sample(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sbx", ["ls", "--json"], { timeout: 15000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `sbx ls exited ${r.code}`);
        this.list = JSON.parse(r.stdout || "[]").map(describe);
        this.error = null;
        if (!this.sampledOnce) { this.sampledOnce = true; this.sample(cx); }
        await this.adopt();
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loaded = true;
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  // One reading per running sandbox, in parallel. CPU is the busy share of the
  // VM's vCPUs since the previous reading, so it shows from the second one on.
  sample(cx) {
    if (this.sampling) return;
    const running = this.list.filter((s) => s.status === "running" && !this.busy.has(s.name));
    const names = new Set(running.map((s) => s.name));
    for (const k of this.stats.keys()) if (!names.has(k)) this.stats.delete(k);
    if (!running.length) return;
    this.sampling = true;
    cx.spawn(async (cx) => {
      await Promise.all(running.map(async (s) => {
        const r = await exec("sbx", ["exec", s.name, "sh", "-c", STATS_SH], { timeout: 8000 }).catch(() => null);
        if (!r || r.code !== 0) return;
        const now = parseStats(r.stdout);
        const prev = this.stats.get(s.name)?.raw;
        const dt = prev ? now.total - prev.total : 0;
        const cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - (now.idle - prev.idle) / dt) * 100)) : null;
        this.stats.set(s.name, { ...now, cpu, raw: now });
      }));
      this.sampling = false;
      cx.notify();
    });
  }

  // Labels unlabelled terminals whose foreground program is `sbx`, sitting in a
  // sandbox's workspace. Each terminal is asked at most every 30s.
  async adopt() {
    const byFolder = new Map();
    for (const s of this.list) byFolder.set(s.folder, [...(byFolder.get(s.folder) ?? []), s]);
    for (const t of terminals()) {
      if (t.state !== "live" || t.address.includes("/") || t.labels?.[LABEL]) continue;
      // Only shells in a sandbox folder, each at most every 30s.
      if (!byFolder.has(t.cwd) || Date.now() - (this.checked.get(t.address) ?? 0) < 30000) continue;
      this.checked.set(t.address, Date.now());
      const r = await hc(["get", t.address]);
      let fg = null;
      try { fg = JSON.parse(r.stdout)?.foreground; } catch {}
      if (fg?.argv?.[0] !== "sbx") continue; // not running sbx (yet)
      // The folder sbx runs in decides, not the shell's (`cd x && sbx env run`).
      const candidates = byFolder.get(fg.cwd) ?? byFolder.get(t.cwd) ?? [];
      const s = pick(candidates, fg.argv, this.list);
      if (s) await hc(["label", t.address, `${LABEL}=${s.name}`]);
    }
  }

  // Live sessions of a sandbox that sit in a pane, agents first.
  sessions(s) {
    const shown = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p]));
    return terminals()
      .filter((t) => t.state === "live" && t.labels?.[LABEL] === s.name && shown.has(t.address))
      .map((t) => ({ t, pane: shown.get(t.address) }))
      .sort((a, b) => (b.pane.status ? 1 : 0) - (a.pane.status ? 1 : 0));
  }

  // The space already working in the sandbox's folder, to put a new tab in.
  spaceFor(s) {
    const cwd = new Map(panes().filter((p) => p.cwd).map((p) => [p.tab, p.cwd]));
    return spaces().find((sp) => !sp.machine && (sp.folder === s.folder || sp.tabs.some((tb) => cwd.get(tb.id) === s.folder)));
  }

  open(s) {
    if (s.workspace_missing) {
      notify({ title: `${s.name}: workspace missing`, body: s.folder, level: "warning" });
      return;
    }
    const existing = this.sessions(s)[0];
    if (existing) run("pane.focus", { pane: existing.pane.pane });
    else this.start(s, startArgv(s), "sbx");
  }

  start(s, argv, name) {
    const sp = this.spaceFor(s);
    if (sp) run("tab.new", { space: sp.id, folder: s.folder, argv, name });
    else run("space.new", { folder: s.folder, argv });
  }

  stop(s, cx) {
    this.busy.add(s.name);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("sbx", ["stop", s.name], { timeout: 60000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: `Couldn't stop ${s.name}`, body: (r.stderr || r.stdout || "").trim(), level: "error" });
      this.busy.delete(s.name);
      this.refresh(cx);
    });
  }

  create(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Folder for the new sandbox" });
      if (!folder) return;
      const env = await exec("test", ["-f", `${folder}/sbxenv.yaml`]).then((r) => r.code === 0, () => false);
      run("space.new", { folder, argv: env ? ["sbx", "env", "run", folder] : ["sbx", "run", "claude", folder] });
      this.refresh(cx);
    });
  }

  dot(t, s, session) {
    const st = session?.pane.status;
    if (st === "working") return svg(ICON("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (st === "blocked" || st === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t[st]);
    if (s.status === "running") return div().size(7).mx(3).flex_none().rounded(4).bg(t.idle ?? t.muted);
    return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.dim);
  }

  button(t, id, icon, tip, onClick) {
    return div()
      .id(id)
      .flex_none()
      .p(2)
      .rounded(4)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((e, cx) => {
        cx.stop_propagation();
        onClick(e, cx);
      })
      .child(svg(ICON(icon)).size(13));
  }

  // "12% ▮ 1.1G": CPU as text and bar (warm when busy), then memory in use, fixed widths so columns line up.
  usage(t, st) {
    const cpu = st.cpu;
    const hot = cpu != null && cpu >= 80 ? t.blocked : cpu != null && cpu >= 40 ? t.working : t.dim;
    const share = cpu == null ? 0 : Math.max(0.04, cpu / 100);
    return h_flex().flex_none().gap(6).items_center().text_size(11).text_color(t.dim)
      .child(div().w(30).text_right().text_color(hot).child(cpu == null ? "…" : `${cpu.toFixed(0)}%`))
      .child(div().w(22).h(4).rounded(2).bg(t.border).child(div().h_full().w(22 * share).rounded(2).bg(hot === t.dim ? t.muted : hot)))
      .child(div().w(34).text_right().child(bytes(st.memUsed)));
  }

  row(t, s, collapsed) {
    const all = this.sessions(s);
    const session = all[0];
    const focused = all.some((x) => x.pane.focused);
    const missing = Boolean(s.workspace_missing);
    const stopping = this.busy.has(s.name);
    const st = s.status === "running" ? this.stats.get(s.name) : null;
    const usage = st ? `\nCPU ${st.cpu == null ? "…" : `${st.cpu.toFixed(0)}%`} of ${st.cpus} vCPU · memory ${bytes(st.memUsed)} / ${bytes(st.memTotal)} · disk ${bytes(st.diskUsed)} / ${bytes(st.diskSize)}` : "";
    const tip = (missing ? `Workspace missing: ${s.folder}` : session ? `Go to ${s.name}` : `Start a session in ${s.name}`) + usage;
    const base = h_flex()
      .id(`sbx-${s.name}`)
      .h(collapsed ? 26 : 30)
      .px(8)
      .flex_none()
      .items_center()
      .gap(collapsed ? 4 : 9)
      .rounded(collapsed ? 0 : 8)
      .when(focused, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(tip)
      .on_hover((on, cx) => {
        if (on) this.hovered = s.name;
        else if (this.hovered === s.name) this.hovered = null;
        cx.notify();
      })
      .on_click(() => this.open(s));
    if (collapsed) return base.justify_center().child(this.dot(t, s, session));
    const label = s.name.replace(/^claude-/, "");
    const hovered = this.hovered === s.name;
    return base
      .child(this.dot(t, s, session))
      .child(div().flex_1().min_w(0).truncate()
        .text_color(missing ? t.dim : s.status === "running" ? t.foreground : t.muted)
        .when(missing, (el) => el.line_through())
        .child(label))
      .when(all.length > 1 && !hovered, (el) => el.child(div().text_size(11).text_color(t.dim).child(`×${all.length}`)))
      .when(stopping, (el) => el.child(div().text_size(11).text_color(t.dim).child("stopping…")))
      .when(hovered && !missing && !stopping, (el) => el
        .child(this.button(t, `sbx-new-${s.name}`, "plus", "New session tab", () => this.start(s, startArgv(s), "sbx")))
        .child(this.button(t, `sbx-sh-${s.name}`, "terminal", "Shell in sandbox", () => this.start(s, shellArgv(s), "sbx shell")))
        .when(s.status === "running", (el) => el.child(this.button(t, `sbx-stop-${s.name}`, "square", "Stop sandbox", (_e, cx) => this.stop(s, cx)))))
      .when(!hovered && !stopping && Boolean(st), (el) => el.child(this.usage(t, st)))
      .when(!hovered && !stopping && !st && Boolean(s.last_used_at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(s.last_used_at))));
  }

  render(cx) {
    const t = theme();
    const collapsed = narrow();
    const list = [...this.list].sort((a, b) =>
      // Running by name (stats polling bumps last_used_at, so it would shuffle them),
      // stopped by when they were last used.
      (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) ||
      (a.status === "running" ? a.name.localeCompare(b.name) : Date.parse(b.last_used_at ?? 0) - Date.parse(a.last_used_at ?? 0)));
    const running = list.filter((s) => s.status === "running").length;

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) => el.child(
        h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().gap(6)
          .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Sandboxes"))
          .when(this.loaded && !this.error, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${running}/${list.length}`)))
          .when(this.stats.size > 0, (el) => el.child(div().text_size(11).text_color(t.dim)
            .tooltip("Memory in use across running sandboxes")
            .child(`· ${bytes([...this.stats.values()].reduce((a, x) => a + (x.memUsed || 0), 0))}`)))
          .child(div().flex_1())
          .child(this.button(t, "sbx-create", "plus", "New sandbox…", (_e, cx) => this.create(cx)))))
      .when(!collapsed && Boolean(this.error), (el) => el.child(
        div().px(16).py(4).text_size(12).text_color(t.blocked).child(`sbx: ${this.error}`)))
      .when(!collapsed && this.loaded && !this.error && list.length === 0, (el) => el.child(
        div().px(16).text_size(12).text_color(t.dim).child("No sandboxes. + starts one in a folder.")))
      .child(v_flex().id("sbx-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar()
        .children(list.map((s) => this.row(t, s, collapsed))));
  }
}
