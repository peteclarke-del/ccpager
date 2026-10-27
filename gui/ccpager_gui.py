#!/usr/bin/env python3
"""ccpager settings window (GTK 4 + libadwaita).

Every action runs the ccpager CLI, so the window and the terminal always agree and
all settings persist in ~/.ccpager/state.json. Requires: python3-gi, GTK 4, libadwaita
  Ubuntu/Debian: sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1
  Fedora:        sudo dnf install python3-gobject gtk4 libadwaita
  Arch:          sudo pacman -S python-gobject gtk4 libadwaita
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import threading

try:
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("Adw", "1")
    from gi.repository import Adw, Gio, GLib, Gtk, Pango
except (ImportError, ValueError) as e:  # missing bindings: say how to fix it
    sys.stderr.write(f"ccpager GUI needs GTK 4 + libadwaita for Python ({e}).\n{__doc__}\n")
    sys.exit(1)

APP_ID = "io.github.ccpager"
HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "bin", "ccpager.js")
MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"]
DEFAULTS = {"keepTurns": 6, "pageStep": 8, "minChars": 1200, "largeContext": 0, "protectAt": 80, "pagingMode": "smart", "smallModel": "claude-haiku-5-5", "protectModel": "claude-sonnet-5-5"}
DESKTOP_FILE = os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "applications", f"{APP_ID}.desktop")


def fmt_tok(n):
    n = n or 0
    if n >= 1e6:
        return f"{n / 1e6:.1f}M"
    if n >= 1e3:
        return f"{n / 1e3:.0f}k" if n >= 1e5 else f"{n / 1e3:.1f}k"
    return str(round(n))


def fmt_dur(ms):
    if ms is None:
        return "?"
    m = round(ms / 60000)
    if m < 1:
        return "under a minute"
    if m < 60:
        return f"{m}m"
    h = m // 60
    if h < 48:
        return f"{h}h {m % 60:02d}m"
    return f"{h // 24}d {h % 24}h"


def fmt_clock(ms):
    if ms is None:
        return "?"
    d = GLib.DateTime.new_from_unix_local(int(ms / 1000))
    today = GLib.DateTime.new_now_local()
    hm = d.format("%H:%M")
    return hm if d.format("%Y%m%d") == today.format("%Y%m%d") else f"{d.format('%a')} {hm}"


LEVEL_CSS = b"""
levelbar block.ok { background-color: @accent_bg_color; }
levelbar block.warn { background-color: @warning_bg_color; }
levelbar block.danger { background-color: @error_bg_color; }
levelbar trough { min-height: 10px; }
"""


def fmt_usd(n):
    n = n or 0
    if n >= 100:
        return f"${n:.0f}"
    if n >= 0.01 or n == 0:
        return f"${n:.2f}" if n else "$0"
    return f"${n:.3f}"


class Cli:
    """Runs `node ccpager.js … --json` off the main thread and reports back on it."""

    def __init__(self, node):
        self.node = node

    def run(self, args, done=None):
        def work():
            try:
                p = subprocess.run([self.node, CLI, *args, "--json"], capture_output=True, text=True, timeout=60)
                out = p.stdout.strip().splitlines()
                try:
                    res = json.loads(out[-1]) if out else {}
                except json.JSONDecodeError:
                    res = {"ok": p.returncode == 0, "text": p.stdout}
                if p.returncode != 0 and res.get("ok") is not False:
                    res = {"ok": False, "error": (p.stderr or p.stdout).strip().lstrip("✗ ") or f"exit {p.returncode}"}
                res.setdefault("ok", p.returncode == 0)
            except Exception as e:  # node missing, timeout, …
                res = {"ok": False, "error": str(e)}
            if done:
                GLib.idle_add(done, res)
        threading.Thread(target=work, daemon=True).start()


def row(title, subtitle=None, widget=None, activatable=True):
    r = Adw.ActionRow(title=title)
    if subtitle:
        r.set_subtitle(subtitle)
    if widget is not None:
        widget.set_valign(Gtk.Align.CENTER)
        r.add_suffix(widget)
        if activatable and isinstance(widget, (Gtk.Switch, Gtk.Button)):
            r.set_activatable_widget(widget)
    return r


class Window(Adw.ApplicationWindow):
    def __init__(self, app, cli):
        super().__init__(application=app, title="ccpager")
        self.set_default_size(720, 760)
        self.cli = cli
        self.status = None
        self.busy = 0
        self.updating = False          # True while we set widgets from status (suppresses handlers)
        self.debounce = {}
        self.project_rows = []

        css = Gtk.CssProvider()
        css.load_from_data(LEVEL_CSS)
        Gtk.StyleContext.add_provider_for_display(self.get_display(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        self.toasts = Adw.ToastOverlay()
        self.stack = Adw.ViewStack()
        header = Gtk.HeaderBar()
        title = Adw.ViewSwitcherTitle(stack=self.stack, title="ccpager")
        header.set_title_widget(title)
        self.spinner = Gtk.Spinner()
        header.pack_end(self.spinner)
        refresh = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh")
        refresh.connect("clicked", lambda *_: self.refresh())
        header.pack_end(refresh)
        bar = Adw.ViewSwitcherBar(stack=self.stack)
        title.connect("notify::title-visible", lambda t, _p: bar.set_reveal(t.get_title_visible()))

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.append(header)
        box.append(self.stack)
        self.stack.set_vexpand(True)
        box.append(bar)
        self.toasts.set_child(box)
        self.set_content(self.toasts)

        self.build_overview()
        self.build_setup()
        self.build_settings()
        self.build_logs()

        self.refresh()
        GLib.timeout_add_seconds(3, self._tick)

    # ---------- plumbing ----------
    def toast(self, text):
        self.toasts.add_toast(Adw.Toast(title=GLib.markup_escape_text(text), timeout=4))

    def act(self, args, ok_msg=None, widget=None, then=None):
        """Run a CLI command, show the result, then refresh the status."""
        self.busy += 1
        self.spinner.start()
        if widget:
            widget.set_sensitive(False)

        def done(res):
            self.busy -= 1
            if not self.busy:
                self.spinner.stop()
            if widget:
                widget.set_sensitive(True)
            if res.get("ok"):
                if ok_msg:
                    self.toast(ok_msg)
            else:
                self.toast(f"Couldn't do that: {res.get('error', 'unknown error')}")
            if then:
                then(res)
            self.refresh()
        self.cli.run(args, done)

    def refresh(self):
        self.cli.run(["status"], self.apply_status)

    def _tick(self):
        if not self.busy:
            self.refresh()
        return True

    def debounced(self, key, fn, ms=700):
        if key in self.debounce:
            GLib.source_remove(self.debounce[key])

        def fire():
            self.debounce.pop(key, None)
            fn()
            return False
        self.debounce[key] = GLib.timeout_add(ms, fire)

    def guarded(self, fn):
        """Wrap a widget handler so it ignores changes we made ourselves."""
        def handler(*a):
            if not self.updating:
                fn(*a)
        return handler

    # ---------- Overview ----------
    def build_overview(self):
        page = Adw.PreferencesPage()

        g = Adw.PreferencesGroup()
        self.gw_row = row("Gateway", "Checking…")
        self.gw_icon = Gtk.Image(icon_name="emblem-synchronizing-symbolic", pixel_size=24)
        self.gw_row.add_prefix(self.gw_icon)
        self.gw_btn = Gtk.Button(label="Start")
        self.gw_btn.add_css_class("pill")
        self.gw_btn.set_valign(Gtk.Align.CENTER)
        self.gw_btn.connect("clicked", self.on_gateway_button)
        self.gw_row.add_suffix(self.gw_btn)
        g.add(self.gw_row)

        self.master = Gtk.Switch()
        self.master.connect("notify::active", self.guarded(self.on_master))
        self.master_row = row("Optimizations", "", self.master)
        g.add(self.master_row)

        self.where_row = row("Used by", "")
        go = Gtk.Button(label="Set up…")
        go.set_valign(Gtk.Align.CENTER)
        go.connect("clicked", lambda *_: self.stack.set_visible_child_name("setup"))
        self.where_row.add_suffix(go)
        g.add(self.where_row)

        self.warn_row = Adw.ActionRow(title="Claude Code is pointed at ccpager, but the gateway isn't running",
                                      subtitle="Requests from Claude Code will fail until it's started.")
        self.warn_row.add_css_class("error")
        self.warn_row.add_prefix(Gtk.Image(icon_name="dialog-warning-symbolic"))
        fix = Gtk.Button(label="Start it", valign=Gtk.Align.CENTER)
        fix.add_css_class("suggested-action")
        fix.connect("clicked", lambda b: self.act(["service", "install"] if (self.status or {}).get("service") else ["enable"], "Gateway started", b))
        self.warn_row.add_suffix(fix)
        self.warn_row.set_visible(False)
        g.add(self.warn_row)
        page.add(g)

        ug = Adw.PreferencesGroup(title="Plan usage",
                                  description="Read from Anthropic's reply to each request, so it updates as you work. Pro/Max plans have a rolling 5-hour session window and a weekly cap.")
        self.usage_group = ug
        self.usage_rows = {}
        self.usage_empty = Adw.ActionRow(title="No usage seen yet",
                                         subtitle="Appears after Claude Code's first request through ccpager. API keys show per-minute limits instead.")
        ug.add(self.usage_empty)
        self.usage_status = Adw.ActionRow(title="Status")
        self.usage_status.set_visible(False)
        ug.add(self.usage_status)
        page.add(ug)

        sg = Adw.PreferencesGroup(title="Savings",
                                  description="Tokens, money and limit headroom. Money is API-equivalent value at list prices: on a Pro/Max plan you don't pay it, but it tracks your limit, since cache reads count almost nothing and cache writes count like fresh input. Net value is the number to watch.")
        grid = Gtk.Grid(column_spacing=24, row_spacing=10, margin_top=16, margin_bottom=16, margin_start=18, margin_end=18)
        grid.set_column_homogeneous(True)
        card = Gtk.Frame()
        card.add_css_class("card")
        card.set_child(grid)
        heads = ["", "Today", "7 days", "All time"]
        for c, h in enumerate(heads):
            lbl = Gtk.Label(label=h, xalign=0 if c == 0 else 1)
            lbl.add_css_class("caption-heading")
            lbl.add_css_class("dim-label")
            grid.attach(lbl, c, 0, 1, 1)
        self.stat_labels = {}
        # (key, title, tooltip). Rows starting with "sep" are section captions.
        metrics = [
            ("sep:Tokens", None, None),
            ("tokens", "Tokens kept out", "Tokens removed from prompts, counted every time they would have been resent. ~4 characters per token."),
            ("reduced", "Prompt reduced by", "Share of all prompt tokens that paging removed."),
            ("sep:Money", None, None),
            ("gross", "Value of tokens kept out", "Priced as cache reads, which is what the removed history would mostly have been. Deliberately conservative."),
            ("rewrite", "Cost of cache rewrites", "Extra cost of moving the cutoff while the cache was warm: the prompt after the change is written to the cache again at 25–40× the read price."),
            ("value", "Net value saved", "Value of tokens kept out minus cache rewrites. Positive means ccpager is paying for itself; negative means it moved the cutoff too often."),
            ("ceiling", "If uncached, up to", "Ceiling: what the same tokens would have cost as fresh input, reached when the cache had expired anyway."),
            ("sep:Limit", None, None),
            ("headroom", "Extra work within your limit", "Net value saved as a share of what the requests actually cost. +5% means about 5% more requests fit before a usage limit."),
            ("time", "Extra time per 5-hour window", "At the pace of your current 5-hour session window, how much longer you can work before reaching the same point. Estimated from the headroom and the window's pace; appears once a pace is known."),
            ("requests", "Requests", None),
        ]
        r = 1
        for key, title, tip in metrics:
            if key.startswith("sep:"):
                cap = Gtk.Label(label=key[4:], xalign=0, margin_top=6 if r > 1 else 0)
                cap.add_css_class("caption-heading")
                cap.add_css_class("dim-label")
                grid.attach(cap, 0, r, 4, 1)
                r += 1
                continue
            t = Gtk.Label(label=title, xalign=0)
            if tip:
                t.set_tooltip_text(tip)
            grid.attach(t, 0, r, 1, 1)
            for c, period in enumerate(["today", "week", "all"], start=1):
                v = Gtk.Label(label="–", xalign=1)
                if key in ("tokens", "value", "headroom"):
                    v.add_css_class("title-4")
                v.add_css_class("numeric")
                if tip:
                    v.set_tooltip_text(tip)
                grid.attach(v, c, r, 1, 1)
                self.stat_labels[(key, period)] = v
            r += 1
        self.cache_lbl = Gtk.Label(xalign=0, wrap=True, margin_top=8)
        self.cache_lbl.add_css_class("dim-label")
        self.cache_lbl.add_css_class("caption")
        grid.attach(self.cache_lbl, 0, r, 4, 1)
        sg.add(card)
        page.add(sg)
        self.stack.add_titled_with_icon(page, "overview", "Overview", "go-home-symbolic")

    def usage_row(self, title):
        r = Adw.ActionRow(title=title)
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10, valign=Gtk.Align.CENTER)
        bar = Gtk.LevelBar(min_value=0, max_value=1, valign=Gtk.Align.CENTER)
        bar.set_size_request(170, 10)
        for o in ("low", "high", "full"):
            try:
                bar.remove_offset_value(o)
            except Exception:
                pass
        bar.add_offset_value("ok", 0.75)
        bar.add_offset_value("warn", 0.95)
        bar.add_offset_value("danger", 1.0)
        pct = Gtk.Label(label="–", xalign=1, width_chars=5)
        pct.add_css_class("title-4")
        pct.add_css_class("numeric")
        box.append(bar)
        box.append(pct)
        r.add_suffix(box)
        self.usage_group.add(r)
        return {"row": r, "bar": bar, "pct": pct}

    @staticmethod
    def usage_subtitle(w):
        when = []
        if w.get("startedAt") is not None and (w.get("span") or 0) >= 3600000:
            when.append(f"started {fmt_clock(w['startedAt'])} · {fmt_dur(w.get('elapsed'))} in")
        if w.get("resetAt") is not None:
            when.append("window has reset; waiting for the next request" if w.get("expired")
                        else f"resets {fmt_clock(w['resetAt'])} (in {fmt_dur(w.get('resetIn'))})")
        lines = [" · ".join(when)] if when else []
        used, rate = w.get("used"), w.get("ratePerHour")
        pace = f"{'+' if rate >= 0 else ''}{100 * rate:.1f}%/h" if rate is not None else None
        if used is not None and used >= 1:
            lines.append("⚠ Limit reached")
        elif w.get("runOutAt") is not None:
            if w.get("runsOutBeforeReset"):
                lines.append(f"⚠ At this pace ({pace}) it runs out at {fmt_clock(w['runOutAt'])}, before the reset")
            else:
                lines.append(f"At this pace ({pace}) it won't run out before the reset")
        elif pace:
            lines.append(f"Pace {pace}: won't run out before the reset")
        elif used is not None and (w.get("span") or 0) >= 3600000 and not w.get("expired"):
            lines.append("Pace appears after a few minutes of use")
        return "\n".join(lines)

    def apply_limits(self, lim):
        windows = (lim or {}).get("windows") or []
        self.usage_empty.set_visible(not windows)
        seen = set()
        for w in windows:
            name = w["name"]
            seen.add(name)
            ui = self.usage_rows.get(name)
            if ui is None:
                ui = self.usage_rows[name] = self.usage_row(w.get("label", name))
            used = w.get("used")
            ui["row"].set_visible(True)
            ui["bar"].set_value(0 if used is None else min(1.0, max(0.0, used)))
            ui["pct"].set_label("–" if used is None else f"{round(100 * used)}%")
            ui["row"].set_subtitle(self.usage_subtitle(w))
            danger = (used is not None and used >= 0.95) or bool(w.get("runsOutBeforeReset"))
            if danger:
                ui["row"].add_css_class("warning")
            else:
                ui["row"].remove_css_class("warning")
        for name, ui in self.usage_rows.items():
            if name not in seen:
                ui["row"].set_visible(False)
        if lim and windows:
            parts = []
            if lim.get("status"):
                parts.append(lim["status"].replace("_", " "))
            if lim.get("claim"):
                parts.append(f"binding window: {lim['claim'].replace('_', ' ')}")
            if lim.get("overage"):
                parts.append(f"extra usage {lim['overage']}")
            if lim.get("ageMs") is not None:
                parts.append(f"updated {fmt_dur(lim['ageMs'])} ago")
            self.usage_status.set_subtitle(" · ".join(parts))
            self.usage_status.set_visible(bool(parts))
        else:
            self.usage_status.set_visible(False)

    def on_master(self, sw, _p):
        on = sw.get_active()
        self.act(["on" if on else "off"], "Optimizations on" if on else "Off: requests now pass through unchanged", sw)

    def on_gateway_button(self, btn):
        s = self.status or {}
        if s.get("gateway", {}).get("running"):
            self.act(["service", "restart"], "Gateway restarted", btn)
        else:
            self.act(["service", "install"], "Gateway started and set to run at login", btn)

    # ---------- Setup ----------
    def build_setup(self):
        page = Adw.PreferencesPage()

        g = Adw.PreferencesGroup(title="Background service",
                                 description="Keeps the gateway running at login, so VS Code and other apps can use it without a terminal open.")
        self.svc_btn = Gtk.Button()
        self.svc_btn.connect("clicked", self.on_service)
        self.svc_row = row("Run at login", "", self.svc_btn, activatable=False)
        g.add(self.svc_row)
        page.add(g)

        g = Adw.PreferencesGroup(title="Use ccpager in",
                                 description="After changing these, reload VS Code (Command Palette → Developer: Reload Window). The CLI and desktop app pick it up on their next start.")
        self.global_sw = Gtk.Switch()
        self.global_sw.connect("notify::active", self.guarded(self.on_global))
        self.global_row = row("All Claude Code apps", "VS Code, JetBrains, the desktop app and the claude CLI", self.global_sw)
        self.global_row.add_prefix(Gtk.Image(icon_name="applications-system-symbolic"))
        g.add(self.global_row)
        page.add(g)

        self.proj_group = Adw.PreferencesGroup(title="Specific projects",
                                               description="Route only these folders through ccpager (writes .claude/settings.local.json in the folder, which git ignores).")
        add = Gtk.Button(icon_name="list-add-symbolic", tooltip_text="Add a project folder")
        add.add_css_class("flat")
        add.connect("clicked", self.on_add_project)
        self.proj_group.set_header_suffix(add)
        self.proj_empty = row("No projects added", "Use + to add a folder")
        self.proj_group.add(self.proj_empty)
        page.add(self.proj_group)

        g = Adw.PreferencesGroup(title="This window")
        self.menu_sw = Gtk.Switch()
        self.menu_sw.connect("notify::active", self.guarded(self.on_menu))
        g.add(row("Show ccpager in the app menu", "Adds a launcher so you can open this window like any other app", self.menu_sw))
        page.add(g)

        g = Adw.PreferencesGroup()
        rm = Gtk.Button(label="Remove ccpager completely…", halign=Gtk.Align.CENTER)
        rm.add_css_class("destructive-action")
        rm.add_css_class("pill")
        rm.connect("clicked", self.on_uninstall)
        g.add(rm)
        page.add(g)
        self.stack.add_titled_with_icon(page, "setup", "Setup", "emblem-system-symbolic")

    def on_service(self, btn):
        s = self.status or {}
        if s.get("service"):
            pointed = s["targets"]["global"]["pointed"] or any(p["pointed"] for p in s["targets"]["projects"])
            if pointed:
                self.toast("Turn off the places that use ccpager first, or use Remove completely")
                return
            self.act(["service", "remove"], "Background service removed", btn)
        else:
            self.act(["service", "install"], "Gateway will now run at login", btn)

    def on_global(self, sw, _p):
        if sw.get_active():
            # `install` = background service + point every Claude Code app at it
            self.act(["install"], "All Claude Code apps now use ccpager. Reload VS Code to apply.", sw)
        else:
            self.act(["disable"], "Claude Code talks to Anthropic directly again. Reload VS Code to apply.", sw)

    def on_add_project(self, _btn):
        def chosen(path):
            if not path:
                return
            first = ["service", "install"] if not (self.status or {}).get("service") else None
            go = lambda *_: self.act(["enable", "--project", path], f"{os.path.basename(path)} now uses ccpager")
            if first:
                self.act(first, None, then=lambda res: res.get("ok") and go())
            else:
                go()
        if hasattr(Gtk, "FileDialog"):  # GTK ≥ 4.10
            dlg = Gtk.FileDialog(title="Choose a project folder")

            def fin(d, res):
                try:
                    f = d.select_folder_finish(res)
                    chosen(f.get_path() if f else None)
                except GLib.Error:
                    pass
            dlg.select_folder(self, None, fin)
        else:
            dlg = Gtk.FileChooserNative(title="Choose a project folder", transient_for=self, action=Gtk.FileChooserAction.SELECT_FOLDER)

            def resp(d, r):
                chosen(d.get_file().get_path() if r == Gtk.ResponseType.ACCEPT and d.get_file() else None)
            dlg.connect("response", resp)
            dlg.show()
            self._native = dlg  # keep a reference

    def on_menu(self, sw, _p):
        args = ["gui", "--install"] if sw.get_active() else ["gui", "--uninstall"]
        self.act(args, "Added to the app menu" if sw.get_active() else "Removed from the app menu", sw)

    def on_uninstall(self, _btn):
        d = Adw.MessageDialog(transient_for=self, heading="Remove ccpager completely?",
                              body="This points Claude Code back at Anthropic everywhere, removes the background service and stops the gateway. Your stats and settings are kept.")
        d.add_response("cancel", "Cancel")
        d.add_response("remove", "Remove")
        d.set_response_appearance("remove", Adw.ResponseAppearance.DESTRUCTIVE)
        d.connect("response", lambda _d, r: r == "remove" and self.act(["uninstall"], "ccpager removed. Reload VS Code to apply."))
        d.present()

    def render_projects(self, projects):
        key = json.dumps(projects)
        if getattr(self, "_proj_key", None) == key:
            return
        self._proj_key = key
        for r in self.project_rows:
            self.proj_group.remove(r)
        self.project_rows = []
        self.proj_empty.set_visible(not projects)
        for p in projects:
            sw = Gtk.Switch(active=p["pointed"])
            sw.connect("notify::active", self.guarded(lambda s, _p, d=p["dir"]: self.act(
                ["enable", "--project", d] if s.get_active() else ["disable", "--project", d],
                None, s, then=lambda _r: None)))
            r = row(os.path.basename(p["dir"]) or p["dir"], p["dir"], sw)
            r.add_prefix(Gtk.Image(icon_name="folder-symbolic"))
            rm = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Remove from list", valign=Gtk.Align.CENTER)
            rm.add_css_class("flat")
            rm.connect("clicked", lambda b, d=p["dir"]: self.act(["disable", "--project", d], f"Removed {os.path.basename(d)}", b))
            r.add_suffix(rm)
            self.proj_group.add(r)
            self.project_rows.append(r)

    # ---------- Settings ----------
    def build_settings(self):
        page = Adw.PreferencesPage()

        g = Adw.PreferencesGroup(title="Features", description="Changes apply to the next request. No restart or reload needed.")
        self.smart_sw = Gtk.Switch()
        self.smart_sw.connect("notify::active", self.guarded(lambda sw, _p: self.act(
            ["set", "pagingMode", "smart" if sw.get_active() else "always"],
            "Paging only when it pays off" if sw.get_active() else "Paging at every step boundary", sw)))
        self.smart_row = row("Only page when it pays off", "Recommended. Moving the cutoff rewrites the prompt cache, which costs ~25–40× a cache read, so ccpager waits until the cache is cold, the context is large, or the saving clearly outweighs it", self.smart_sw)
        self.feat = {}
        for name, title, sub in [
            ("paging", "Context paging", "Replace old, bulky tool output (file reads, test logs) with short stubs"),
            ("cache", "Force the 1-hour cache window", "Off by default: Claude Code already asks for the 1-hour cache where it pays (your main conversation on a subscription) and uses 5 minutes for subagents, where an hour costs double to write. Turn on only with an API key, or set promptCacheTtl in Claude Code instead"),
            ("routing", "Model routing", "Send short, simple instructions to a smaller model. Off by default: switching models starts that turn's cache cold"),
            ("protect", "Protect the usage limit", "When a usage window would run out before it resets (or passes the threshold below), start new sessions such as subagents on the protect model and route light turns to the small model, until the pace is safe. Conversations already under way are never switched"),
        ]:
            sw = Gtk.Switch()
            sw.connect("notify::active", self.guarded(lambda s, _p, n=name: self.act(
                ["on" if s.get_active() else "off", n], f"{n.capitalize()} {'on' if s.get_active() else 'off'}", s)))
            g.add(row(title, sub, sw))
            self.feat[name] = sw
            if name == "paging":
                g.add(self.smart_row)
        self.model_dd = Gtk.DropDown.new_from_strings(MODELS)
        self.model_dd.connect("notify::selected", self.guarded(self.on_model))
        self.model_row = row("Small model", "Where routed turns go", self.model_dd, activatable=False)
        g.add(self.model_row)
        page.add(g)

        g = Adw.PreferencesGroup(title="Tuning")
        self.spins = {}
        for name, title, lo, hi, step in [
            ("keepTurns", "Recent steps kept in full", 1, 200, 1),
            ("pageStep", "Steps between cutoff moves", 1, 100, 1),
            ("minChars", "Smallest output to page (characters)", 0, 1_000_000, 100),
            ("largeContext", "Page anyway above this many prompt tokens (0 = off)", 0, 2_000_000, 10_000),
            ("protectAt", "Protect when a usage window passes this percent", 1, 100, 5),
        ]:
            sp = Gtk.SpinButton.new_with_range(lo, hi, step)
            sp.set_numeric(True)
            sp.connect("value-changed", self.guarded(lambda s, n=name: self.debounced(
                n, lambda: self.act(["set", n, str(int(s.get_value()))], f"{n} = {int(s.get_value())}"))))
            r = row(title, "", sp, activatable=False)
            g.add(r)
            self.spins[name] = (sp, r)
        page.add(g)

        g = Adw.PreferencesGroup(title="Connection")
        self.port_spin = Gtk.SpinButton.new_with_range(1024, 65535, 1)
        self.port_spin.set_numeric(True)
        apply_port = Gtk.Button(label="Apply", valign=Gtk.Align.CENTER)
        apply_port.connect("clicked", lambda b: self.act(["set", "port", str(int(self.port_spin.get_value()))],
                                                         "Port changed. Reload VS Code to apply.", b))
        self.port_row = row("Local port", "Changing it restarts the gateway and updates Claude Code's settings", self.port_spin, activatable=False)
        self.port_row.add_suffix(apply_port)
        g.add(self.port_row)
        page.add(g)

        g = Adw.PreferencesGroup()
        reset = Gtk.Button(label="Reset tuning to defaults", halign=Gtk.Align.CENTER)
        reset.add_css_class("pill")
        reset.connect("clicked", self.on_reset)
        g.add(reset)
        page.add(g)
        self.stack.add_titled_with_icon(page, "settings", "Settings", "preferences-other-symbolic")

    def on_model(self, dd, _p):
        m = dd.get_model().get_string(dd.get_selected())
        self.act(["set", "smallModel", m], f"Routed turns go to {m}", dd)

    def on_reset(self, btn):
        cmds = [["set", k, str(v)] for k, v in DEFAULTS.items()]

        def step(i=0, _res=None):
            if i < len(cmds):
                self.act(cmds[i], "Tuning reset to defaults" if i == len(cmds) - 1 else None, btn,
                         then=lambda res: step(i + 1, res))
        step()

    # ---------- Logs ----------
    def build_logs(self):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        tools = Gtk.Box(spacing=8, margin_top=8, margin_bottom=8, margin_start=12, margin_end=12)
        self.follow = Gtk.CheckButton(label="Follow", active=True)
        tools.append(self.follow)
        self.log_path_lbl = Gtk.Label(xalign=0, hexpand=True, ellipsize=Pango.EllipsizeMode.MIDDLE)
        self.log_path_lbl.add_css_class("dim-label")
        self.log_path_lbl.add_css_class("caption")
        tools.append(self.log_path_lbl)
        clear = Gtk.Button(label="Clear view")
        clear.connect("clicked", lambda *_: self.log_buf.set_text(""))
        tools.append(clear)
        openf = Gtk.Button(label="Open file")
        openf.connect("clicked", self.on_open_log)
        tools.append(openf)
        box.append(tools)

        self.log_view = Gtk.TextView(editable=False, monospace=True, cursor_visible=False, wrap_mode=Gtk.WrapMode.WORD_CHAR,
                                     left_margin=12, right_margin=12, top_margin=8, bottom_margin=8)
        self.log_buf = self.log_view.get_buffer()
        sc = Gtk.ScrolledWindow(vexpand=True, child=self.log_view)
        box.append(sc)
        self.log_hint = Gtk.Label(label="Send a message in Claude Code and a line appears here for each request.", margin_bottom=8)
        self.log_hint.add_css_class("dim-label")
        self.log_hint.add_css_class("caption")
        box.append(self.log_hint)

        self.log_pos = 0
        self.log_file = None
        GLib.timeout_add(500, self.tail_log)
        self.stack.add_titled_with_icon(box, "logs", "Logs", "utilities-terminal-symbolic")

    def tail_log(self):
        f = self.log_file
        if not f:
            return True
        try:
            size = os.path.getsize(f)
        except OSError:
            if self.log_pos:
                self.log_pos = 0
            return True
        if size < self.log_pos:  # rotated
            self.log_pos = 0
        if size > self.log_pos:
            with open(f, "rb") as fh:
                if self.log_pos == 0 and size > 200_000:  # first load: just the tail
                    fh.seek(size - 200_000)
                    fh.readline()
                else:
                    fh.seek(self.log_pos)
                chunk = fh.read().decode("utf-8", "replace")
            self.log_pos = size
            self.log_buf.insert(self.log_buf.get_end_iter(), "".join(self.compact(l) for l in chunk.splitlines(True)))
            lines = self.log_buf.get_line_count()
            if lines > 3000:  # keep the view light
                it = self.log_buf.get_iter_at_line(lines - 3000)
                it = it[1] if isinstance(it, tuple) else it  # PyGObject returns (ok, iter) on GTK 4
                self.log_buf.delete(self.log_buf.get_start_iter(), it)
            if self.follow.get_active():
                GLib.idle_add(lambda: self.log_view.scroll_to_mark(self.log_buf.get_insert(), 0, False, 0, 1) or False)
                self.log_buf.place_cursor(self.log_buf.get_end_iter())
        return True

    @staticmethod
    def compact(line):
        """'2026-10-25T23:31:37.373Z INFO /v1/messages model=… ' → '23:31:37  model=…' (local time)."""
        parts = line.split(" ", 2)
        if len(parts) < 3 or "T" not in parts[0]:
            return line
        try:
            from datetime import datetime
            t = datetime.fromisoformat(parts[0].replace("Z", "+00:00")).astimezone().strftime("%H:%M:%S")
        except ValueError:
            return line
        msg = parts[2].replace("/v1/messages ", "")
        level = "" if parts[1] == "INFO" else f"{parts[1]} "
        return f"{t}  {level}{msg}"

    def on_open_log(self, _btn):
        if not self.log_file or not os.path.exists(self.log_file):
            self.toast("No log file yet")
            return
        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(self.log_file, None), None)

    # ---------- status → widgets ----------
    def apply_status(self, s):
        if not s.get("ok"):
            self.gw_row.set_subtitle(f"Couldn't read status: {s.get('error', '')}")
            return False
        self.status = s
        self.updating = True
        try:
            g = s["gateway"]
            running = g["running"]
            self.gw_icon.set_from_icon_name("emblem-ok-symbolic" if running else "process-stop-symbolic")
            for c in ("success", "error"):
                self.gw_icon.remove_css_class(c)
            self.gw_icon.add_css_class("success" if running else "error")
            if g.get("legacy"):
                self.gw_row.set_subtitle("An older ccpager is running. Restart to update it.")
            else:
                self.gw_row.set_subtitle(f"Running on {g['url']}" + (f" · {s['service']}" if s.get("service") else " · not set to run at login")
                                         if running else "Not running")
            self.gw_btn.set_label("Restart" if running else "Start")

            m = s["mode"]
            self.master.set_active(m["enabled"])
            on = [n for n in ("paging", "cache", "routing", "protect") if m[n]]
            if m.get("protect") and s.get("protect", {}).get("active"):
                on = [n for n in on if n != "protect"] + [f"protect ACTIVE ({s['protect']['reason']})"]
            self.master_row.set_subtitle(("On: " + ", ".join(on) if on else "On, but every feature is switched off")
                                         if m["enabled"] else "Off: requests pass through unchanged")
            for n, sw in self.feat.items():
                sw.set_active(m[n])
                sw.set_sensitive(m["enabled"])
            self.model_row.set_sensitive(m["enabled"] and m["routing"])
            self.smart_sw.set_active(s["settings"].get("pagingMode", "smart") == "smart")
            self.smart_row.set_sensitive(m["enabled"] and m["paging"])

            t = s["targets"]
            where = []
            if t["global"]["pointed"]:
                where.append("all Claude Code apps")
            projs = [p for p in t["projects"] if p["pointed"]]
            if projs:
                where.append(f"{len(projs)} project{'s' if len(projs) != 1 else ''}")
            text = ", ".join(where)
            self.where_row.set_subtitle(text[:1].upper() + text[1:] if where else "Nothing yet. Claude Code talks to Anthropic directly")
            self.warn_row.set_visible(bool(where) and not running)

            self.global_sw.set_active(t["global"]["pointed"])
            self.global_row.set_subtitle(f"VS Code, JetBrains, the desktop app and the claude CLI · {t['global']['file']}")
            self.render_projects(t["projects"])
            self.svc_row.set_subtitle(s["service"] or ("Not installed. The gateway is running only until you log out" if running else "Not installed"))
            self.svc_btn.set_label("Remove" if s.get("service") else "Install")
            for c in ("suggested-action", "destructive-action"):
                self.svc_btn.remove_css_class(c)
            if not s.get("service"):
                self.svc_btn.add_css_class("suggested-action")
            self.menu_sw.set_active(os.path.exists(DESKTOP_FILE))

            st = s["settings"]
            help_ = s.get("settingsHelp", {})
            for n, (sp, r) in self.spins.items():
                if n not in self.debounce:  # don't fight the user mid-edit
                    sp.set_value(st[n])
                r.set_subtitle(help_.get(n, "").capitalize())
            if not self.port_spin.has_focus():
                self.port_spin.set_value(st["port"])
            model = st["smallModel"]
            model_list = self.model_dd.get_model()
            names = [model_list.get_string(i) for i in range(model_list.get_n_items())]
            if model not in names:
                model_list.append(model)
                names.append(model)
            self.model_dd.set_selected(names.index(model))

            self.apply_limits(s.get("limits"))

            stats = s.get("stats")
            lim = s.get("limits") or {}
            w5h = next((w for w in lim.get("windows", []) if w.get("name") == "5h"), None)
            rate = (w5h or {}).get("ratePerHour")   # share of the 5-hour window used per hour, at the current pace
            used = (w5h or {}).get("used")
            for period in ("today", "week", "all"):
                b = (stats or {}).get(period) or {}
                n = b.get("requests", 0)
                self.stat_labels[("tokens", period)].set_label(f"~{fmt_tok(b.get('tokensSaved', 0))}")
                self.stat_labels[("reduced", period)].set_label(f"{round(100 * b.get('reduced', 0))}%" if n else "–")
                self.stat_labels[("gross", period)].set_label(fmt_usd(b.get("savedLow", 0)))
                rw = b.get("rewriteCost", 0)
                self.stat_labels[("rewrite", period)].set_label(("−" if rw else "") + fmt_usd(rw))
                net = b.get("net", b.get("savedLow", 0))
                vl = self.stat_labels[("value", period)]
                vl.set_label(("−" if net < 0 else "+" if net > 0 else "") + fmt_usd(abs(net)))
                vl.remove_css_class("success"); vl.remove_css_class("error")
                if n:
                    vl.add_css_class("error" if net < 0 else "success")
                self.stat_labels[("ceiling", period)].set_label(fmt_usd(b.get("savedHigh", 0)))
                cost = b.get("cost", 0)
                head = net / cost if cost else None
                hl = self.stat_labels[("headroom", period)]
                hl.set_label(f"{'+' if head >= 0 else '−'}{abs(100 * head):.1f}%" if head is not None and n else "–")
                hl.remove_css_class("success"); hl.remove_css_class("error")
                if head is not None and n:
                    hl.add_css_class("error" if head < 0 else "success")
                # time: with headroom h, reaching today's point in the window takes (1+h)× as long
                if head is not None and n and rate and rate > 0 and used:
                    extra_min = head * (used / rate) * 60
                    self.stat_labels[("time", period)].set_label(("+" if extra_min >= 0 else "−") + fmt_dur(abs(extra_min) * 60000))
                else:
                    self.stat_labels[("time", period)].set_label("–")
                self.stat_labels[("requests", period)].set_label(str(n))
            if stats:
                bits = [f"Cache hit rate {100 * stats['cacheHitRate']:.1f}%", f"{stats['pagedBlocks']} blocks paged"]
                if stats.get("routed"):
                    bits.append(f"{stats['routed']} turns routed to a smaller model")
                if stats.get("protected"):
                    bits.append(f"{stats['protected']} sessions started on the protect model")
                w = (stats.get("cacheWrite1h") or 0) + (stats.get("cacheWrite5m") or 0)
                if w:
                    bits.append(f"cache writes {round(100 * stats['cacheWrite1h'] / w)}% on the 1-hour tier")
                bits.append(f"busiest hour {stats['busiestHour']}:00")
                if not (rate and rate > 0):
                    bits.append("extra time appears once the 5-hour window has a pace")
                self.cache_lbl.set_label(" · ".join(bits))
            else:
                self.cache_lbl.set_label("No requests yet. Numbers appear after Claude Code sends its first message through ccpager.")

            if s["logFile"] != self.log_file:
                self.log_file = s["logFile"]
                self.log_pos = 0
                self.log_buf.set_text("")
            self.log_path_lbl.set_label(self.log_file)
            self.log_hint.set_visible(not os.path.exists(self.log_file) or os.path.getsize(self.log_file) == 0)
        finally:
            self.updating = False
        return False


class App(Adw.Application):
    def __init__(self, cli, page):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.cli = cli
        self.page = page
        GLib.set_application_name("ccpager")

    def do_activate(self):
        win = self.props.active_window or Window(self, self.cli)
        if self.page:
            win.stack.set_visible_child_name(self.page)
        win.present()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--node", default=shutil.which("node") or "node")
    ap.add_argument("--page", choices=["overview", "setup", "settings", "logs"])
    a, rest = ap.parse_known_args()
    Gtk.Window.set_default_icon_name("ccpager")
    icon_dir = HERE  # lets the window icon work before `ccpager gui --install`
    theme = Gtk.IconTheme.get_for_display(Gdk_display()) if Gdk_display() else None
    if theme:
        theme.add_search_path(icon_dir)
    return App(Cli(a.node), a.page).run([sys.argv[0], *rest])


def Gdk_display():
    try:
        gi.require_version("Gdk", "4.0")
        from gi.repository import Gdk
        return Gdk.Display.get_default()
    except Exception:
        return None


if __name__ == "__main__":
    sys.exit(main())
