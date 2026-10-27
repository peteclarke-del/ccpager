"""Drives the real GUI widgets under Xvfb and checks each one changes and persists the setting."""
import json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gui"))
import ccpager_gui as g
from gi.repository import GLib

home = os.environ["CCPAGER_HOME"]
claude_settings = os.path.join(os.environ["HOME"], ".claude", "settings.json")
state = lambda: json.load(open(os.path.join(home, "state.json")))
pointed = lambda: "ANTHROPIC_BASE_URL" in json.load(open(claude_settings)).get("env", {})
results, app = [], None

def check(name, cond):
    results.append((name, bool(cond)))
    print(("  ✓ " if cond else "  ✗ ") + name, flush=True)

def steps(w):
    yield 2.5  # first status load
    check("status loaded into the window", w.status and w.status["gateway"]["running"])
    check("savings shown", w.stat_labels[("requests", "all")].get_label() not in ("0", "–"))
    check("plan usage group present", w.usage_group is not None and (w.usage_empty.get_visible() or w.usage_rows))
    w.master.set_active(False); yield 2.5
    check("master switch off → saved enabled=false", state().get("enabled") is False)
    check("overview subtitle says pass-through", "pass through" in w.master_row.get_subtitle())
    w.master.set_active(True); yield 2.5
    check("master switch on → saved", state().get("enabled") is True)
    w.feat["routing"].set_active(True); yield 2.5
    check("routing switch → saved", state().get("routing") is True)
    check("model picker enabled once routing on", w.model_row.get_sensitive())
    w.model_dd.set_selected(1); yield 2.5
    check("model picker → saved", state().get("smallModel") == "claude-sonnet-5-5")
    w.spins["keepTurns"][0].set_value(8); yield 3
    check("spin button (debounced) → saved", state().get("keepTurns") == 8)
    w.global_sw.set_active(False); yield 3
    check("'All Claude Code apps' off → settings.json unpointed", not pointed())
    w.global_sw.set_active(True); yield 4
    check("'All Claude Code apps' on → settings.json pointed", pointed())
    w.menu_sw.set_active(True); yield 2.5
    check("app menu switch → .desktop file written", os.path.exists(g.DESKTOP_FILE))
    w.stack.set_visible_child_name("logs"); yield 1.5
    text = w.log_buf.get_text(w.log_buf.get_start_iter(), w.log_buf.get_end_iter(), False)
    check("log view shows compact request lines", "  model=claude-opus-5-5" in text and "INFO" not in text)
    app.quit()

def run(w):
    it = steps(w)
    def nxt():
        try:
            GLib.timeout_add(int(next(it) * 1000), nxt)
        except StopIteration:
            pass
        return False
    nxt()

class TestApp(g.App):
    def do_activate(self):
        g.App.do_activate(self)
        run(self.props.active_window)

app = TestApp(g.Cli(os.environ.get("NODE", "node")), None)
app.run([sys.argv[0]])
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} GUI checks passed")
sys.exit(1 if failed or not results else 0)
