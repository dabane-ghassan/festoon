#!/usr/bin/env python3
"""End-to-end tests for Festoon, in a real (headless) GNOME Shell.

Starts a private session bus and `gnome-shell --headless`, loads the extension from this
checkout (which starts the line), and drives it with a virtual mouse and keyboard. A plain GTK
window (probe-app.js) sits underneath: it logs the clicks and drops it receives and copies to
the clipboard on request. Screenshots land in tests/out/.

    python3 tests/run.py            # or: make test
    python3 tests/run.py --keep     # keep the temporary home folder, for poking around

Needs gnome-shell, gjs, GTK 4 and libadwaita. In a container you also need a system D-Bus
(`dbus-daemon --system --fork`) and no stale /run/systemd/seats directory.
"""
import json
import pathlib
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from rig import Rig  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
UUID = "festoon@dabane-ghassan.github.io"
OUT = ROOT / "tests" / "out"
LINE = ("io.github.dabane_ghassan.Festoon.Line", "/io/github/dabane_ghassan/Festoon/Line")
LINE_IFACE = "io.github.dabane_ghassan.Festoon.Line"
SHELL = ("org.gnome.Shell", "/io/github/dabane_ghassan/Festoon")
SHELL_IFACE = "io.github.dabane_ghassan.Festoon"
PICTURE = ROOT / "tests" / "picture.png"


def picture(path, w, h):
    subprocess.run(["rsvg-convert", "-w", str(w), "-h", str(h), "--keep-aspect-ratio", str(ROOT / "tests/picture.svg"),
                    "-o", str(path)], check=True)


def unwrap(out):
    """('<json>',) from gdbus, as a Python value."""
    import ast
    out = out.strip()
    if not out.startswith("("):
        raise RuntimeError(out)
    value = ast.literal_eval(out)
    return value[0] if value else None


class Festoon:
    def __init__(self, rig):
        self.rig = rig
        self.probe_log = rig.tmp / "probe.log"
        self.probe_cmd = rig.tmp / "probe.cmd"

    def line(self, method, *args):
        return self.rig.gdbus(*LINE, f"{LINE_IFACE}.{method}", *args)

    def shell(self, method, *args):
        return self.rig.gdbus(*SHELL, f"{SHELL_IFACE}.{method}", *args)

    def state(self):
        return json.loads(unwrap(self.line("GetState")))

    def items(self):
        return json.loads(unwrap(self.line("GetItems")))

    def items_full(self):
        index = json.loads((self.rig.home / ".local/share/festoon/items.json").read_text())
        return index["items"]

    def layout(self):
        """Card rectangles on screen."""
        rects = json.loads(unwrap(self.line("GetLayout")))
        x0, y0 = self.window_origin()
        for r in rects:
            r["rect"]["x"] += x0
            r["rect"]["y"] += y0
        return rects

    def window_origin(self):
        return self.rig.js("(() => { const r = global._t.ext().keeper.window.get_frame_rect(); return [r.x, r.y]; })()")

    def center(self, item_id):
        for r in self.layout():
            if r["id"] == item_id:
                rect = r["rect"]
                return rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] * 0.55
        raise KeyError(item_id)

    def clipboard(self):
        self.rig.js("global._clip = null; imports.gi.St.Clipboard.get_default().get_text(imports.gi.St.ClipboardType.CLIPBOARD, (c, t) => { global._clip = t; }); 1")
        time.sleep(0.3)
        return self.rig.js("global._clip")

    def clipboard_types(self):
        return self.rig.js("imports.gi.St.Clipboard.get_default().get_mimetypes(imports.gi.St.ClipboardType.CLIPBOARD)")

    def wait(self, predicate, timeout=5.0, step=0.15):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if predicate():
                    return True
            except Exception:  # noqa: BLE001 - the line may be restarting
                pass
            time.sleep(step)
        return False

    def open_probe(self):
        self.probe_log.write_text("")
        self.probe_cmd.write_text("")
        self.rig.spawn(["gjs", "-m", str(ROOT / "tests/probe-app.js"), str(self.probe_log), str(self.probe_cmd)])
        self.wait(lambda: "ready" in self.probe_log.read_text(), 15)
        time.sleep(1.2)
        self.rig.t("move(640, 600)")
        self.rig.t("click()", 0.4)
        self.probe_log.write_text("")

    def probe(self, clear=True):
        time.sleep(0.2)
        lines = [line for line in self.probe_log.read_text().split("\n") if line]
        if clear:
            self.probe_log.write_text("")
        return lines

    def probe_do(self, *cmd):
        """Have the probe app copy something (it needs to be focused, like any app)."""
        self.rig.t("move(640, 640)")
        self.rig.t("click()", 0.2)
        with open(self.probe_cmd, "a") as f:
            f.write(" ".join(cmd) + "\n")
        self.wait(lambda: f"did {cmd[0]}" in self.probe_log.read_text(), 4)
        time.sleep(0.6)
        self.probe_log.write_text("")

    def shot(self, name):
        return self.rig.shot(OUT / f"{name}.png")

    def rest_on_top_bar(self, x=520, y=14, wait=1.0):
        self.rig.t(f"move({x}, {y})", 0.05)
        self.rig.t(f"move({x + 1}, {y})", wait)

    def leave(self, wait=1.0):
        self.rig.t("move(640, 700)", wait)


class Results:
    def __init__(self):
        self.failed = []
        self.count = 0

    def check(self, name, ok, detail=""):
        self.count += 1
        print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"   [{detail}]" if detail and not ok else ""))
        if not ok:
            self.failed.append(name)


def run(rig, r):
    f = Festoon(rig)
    presses = lambda lines: [x for x in lines if x.startswith("press")]

    print("starting")
    r.check("the line starts and answers on D-Bus", f.wait(lambda: f.state()["running"], 15))
    r.check("the shell finds its window", f.wait(lambda: rig.js("!!global._t.ext().keeper.window"), 8))
    win = rig.js("(() => { const w = global._t.ext().keeper.window; const r = w.get_frame_rect(); return {above: w.is_above(), all: w.is_on_all_workspaces(), skip: w.skip_taskbar, x: r.x, y: r.y, w: r.width, panel: Main.layoutManager.panelBox.height}; })()")
    r.check("it stays above other windows, on every workspace", win["above"] and win["all"], win)
    r.check("it is kept out of the overview and Alt+Tab", win["skip"], win)
    r.check("it spans the screen just under the top bar", win["x"] == 0 and win["w"] == 1280 and win["y"] == win["panel"], win)
    r.check("it never takes the keyboard while it is up", rig.js("global.display.focus_window !== global._t.ext().keeper.window"))
    rig.js("global._t.ext().keeper.window.move_resize_frame(false, 0, 32, 700, 300); 1")
    r.check("if something resizes it, it goes back to the full width", f.wait(lambda: rig.js("global._t.ext().keeper.window.get_frame_rect().width") == 1280, 3))
    r.check("the shell side knows the line's state", f.wait(lambda: json.loads(unwrap(f.shell("GetState")))["line"]["running"], 5))
    r.check("the line starts empty and up", f.state()["count"] == 0 and not f.state()["down"])

    f.open_probe()
    rig.t("move(1100, 120)")
    rig.t("click()")
    r.check("while it is up, clicks under it reach the window below", len(presses(f.probe())) == 1)

    print("coming down")
    before = f.shot("00-up")
    f.rest_on_top_bar()
    r.check("resting on the top bar brings the line down", f.state()["down"] and f.state()["reason"] == "hover", f.state())
    after = f.shot("01-empty-line")
    from PIL import Image
    spot = (1100, 330)
    r.check("it is see-through, even with a theme that paints every window",
            Image.open(before).convert("RGB").getpixel(spot) == Image.open(after).convert("RGB").getpixel(spot),
            (Image.open(before).convert("RGB").getpixel(spot), Image.open(after).convert("RGB").getpixel(spot)))
    rig.t("move(640, 90)", 0.6)
    r.check("it stays down while the pointer is on it", f.state()["down"])
    rig.t("click()")
    r.check("and clicks there belong to the line", presses(f.probe()) == [])
    f.leave()
    r.check("moving away puts it back up", not f.state()["down"])
    rig.t("move(1100, 120)")
    rig.t("click()")
    r.check("after which clicks go through again", len(presses(f.probe())) == 1)

    clock = rig.js("(() => { const a = Main.panel.statusArea.dateMenu; const [x, y] = a.get_transformed_position(); return [x + a.width / 2, y + a.height / 2]; })()")
    f.rest_on_top_bar(clock[0], clock[1])
    r.check("resting on a top-bar button (the clock) does not", not f.state()["down"])
    f.rest_on_top_bar(clock[0], 0)
    r.check("but the very top edge above it does", f.state()["down"])
    f.leave()
    rig.js("global._t.ext().settings.set_boolean('reveal-on-hover', false); 1")
    f.rest_on_top_bar()
    r.check("with hovering turned off, resting does nothing", not f.state()["down"])
    rig.js("global._t.ext().settings.reset('reveal-on-hover'); global._t.ext().settings.set_boolean('reveal-edge-only', true); 1")
    f.rest_on_top_bar()
    r.check("set to the top edge only, resting lower on the bar does nothing", not f.state()["down"])
    f.rest_on_top_bar(520, 0)
    r.check("while the very top edge still brings it down", f.state()["down"])
    f.leave()
    rig.js("global._t.ext().settings.reset('reveal-edge-only'); 1")
    f.leave(0.3)

    print("copying in apps")
    f.probe_do("copy-text", "Shopping list\\nbread\\nolive oil\\ntomatoes")
    items = f.items()
    r.check("copied text hangs as a note", len(items) == 1 and items[0]["kind"] == "note", items)
    r.check("with its first line as the title", items and items[0]["title"] == "Shopping list", items)
    f.probe_do("copy-text", "https://www.example.org/docs/getting-started?lang=en")
    items = f.items()
    r.check("a copied web address hangs as a link", items[0]["kind"] == "link" and items[0]["title"] == "example.org", items[:1])
    f.probe_do("copy-secret", "hunter2")
    r.check("a password manager's secret is never kept", len(f.items()) == 2 and all(i["text"] != "hunter2" for i in f.items()))
    f.probe_do("copy-image", str(PICTURE))
    items = f.items()
    r.check("a copied image hangs", items[0]["kind"] == "image" and pathlib.Path(items[0]["path"]).exists(), items[:1])
    r.check("Festoon keeps its own copy of it", items and str(rig.home) in items[0]["path"], items[:1])
    f.probe_do("copy-text", "Shopping list\\nbread\\nolive oil\\ntomatoes")
    r.check("copying the same thing again does not hang it twice", len(f.items()) == 3 and f.items()[0]["kind"] == "note")
    rig.js("global._t.ext().settings.set_boolean('hang-text', false); 1")
    f.probe_do("copy-text", "not wanted")
    r.check("with text turned off, copied text is left alone", len(f.items()) == 3)
    rig.js("global._t.ext().settings.reset('hang-text'); 1")
    other = rig.tmp / "holiday.png"
    picture(other, 600, 420)
    f.probe_do("copy-files", str(other))
    items = f.items()
    r.check("a picture file copied in Files hangs, pointing at the file", items[0]["path"] == str(other) and items[0]["kind"] == "image", items[:1])

    print("screenshots")
    shots = pathlib.Path(f.state()["screenshots"])
    before = len(f.items())
    picture(shots / "Screenshot from 2026-11-16 10-00-00.png", 1000, 620)
    r.check("a new screenshot hangs", f.wait(lambda: len(f.items()) == before + 1 and f.items()[0]["kind"] == "screenshot"))
    r.check("and the line comes down for a moment to show it", f.wait(lambda: f.state()["down"] and f.state()["reason"] == "peek", 2))
    f.shot("02-peek")
    r.check("then goes back up by itself", f.wait(lambda: not f.state()["down"], 5))
    r.check("the screenshot stays where GNOME saved it", f.items()[0]["path"].startswith(str(shots)))

    rig.js("global._t.ext().settings.set_boolean('quiet-screenshots', true); 1")
    count = len(f.items())
    rig.keys("Print", wait=1.6)
    rig.keys("Return", wait=2.5)
    r.check("GNOME's own screenshot tool hangs its screenshot, once", f.wait(lambda: len(f.items()) == count + 1, 5) and f.items()[0]["kind"] == "screenshot",
            [i["kind"] for i in f.items()])
    banners = rig.js("Main.messageTray.getSources().filter(s => s.iconName === 'screenshot-recorded-symbolic').reduce((n, s) => n + s.notifications.length, 0)")
    r.check("and its notification can be skipped", banners == 0, banners)
    rig.js("global._t.ext().settings.reset('quiet-screenshots'); 1")
    f.wait(lambda: not f.state()["down"], 5)

    print("on the line")
    rig.shell_cmd = None
    f.shell("Show")
    f.wait(lambda: f.state()["down"], 2)
    time.sleep(1.2)
    f.shot("03-line")
    note = next(i for i in f.items() if i["kind"] == "note")
    x, y = f.center(note["id"])
    rig.t(f"move({x}, {y})", 0.6)
    f.shot("04-hover")
    rig.t("click()", 0.5)
    r.check("clicking a note copies its text", f.clipboard() == "Shopping list\nbread\nolive oil\ntomatoes", f.clipboard())
    r.check("clicking the line never reaches the window below", presses(f.probe()) == [])
    r.check("copying it does not hang it again", len(f.items()) == count + 1)
    link = next(i for i in f.items() if i["kind"] == "link")
    x, y = f.center(link["id"])
    rig.t(f"move({x}, {y})", 0.4)
    rig.t("click()", 0.5)
    r.check("clicking a link copies the address", f.clipboard() == "https://www.example.org/docs/getting-started?lang=en", f.clipboard())
    shot = next(i for i in f.items() if i["kind"] == "screenshot")
    x, y = f.center(shot["id"])
    rig.t(f"move({x}, {y})", 0.4)
    rig.t("click()", 0.5)
    r.check("clicking a screenshot copies the picture", "image/png" in (f.clipboard_types() or []), f.clipboard_types())
    f.shot("05-copied")

    print("letting go")
    count = len(f.items())
    target = f.items()[1]
    x, y = f.center(target["id"])
    rig.t(f"move({x}, {y})", 0.6)
    rect = next(e["rect"] for e in f.layout() if e["id"] == target["id"])
    rig.t(f"move({rect['x'] + rect['width'] - 4 * 1.28}, {rect['y'] + 9 * 1.28})", 0.5)
    rig.t("click()", 0.8)
    r.check("the cross lets an item go", len(f.items()) == count - 1 and target["id"] not in [i["id"] for i in f.items()], len(f.items()))
    r.check("Put Back brings it back", "true" in f.line("PutBack") and target["id"] in [i["id"] for i in f.items()])
    x, y = f.center(target["id"])
    rig.t(f"move({x}, {y})", 0.5)
    rig.t("click(2)", 0.8)
    r.check("so does a middle-click", target["id"] not in [i["id"] for i in f.items()])
    f.line("PutBack")
    time.sleep(0.4)

    print("dragging into an app")
    f.leave(0.8)
    f.shell("Show")
    f.wait(lambda: f.state()["down"], 2)
    time.sleep(1.0)
    pic = next(i for i in f.items() if i["kind"] == "screenshot")
    x, y = f.center(pic["id"])
    rig.t(f"move({x}, {y})", 0.4)
    rig.t("down()", 0.15)
    rig.t(f"glide([[{x}, {y}], [{x + 20}, {y + 30}], [{x + 120}, {y + 220}], [640, 560]], 500)", 0.9)
    rig.t("move(642, 562)", 0.4)
    f.shot("06-dragging")
    rig.t("up()", 1.0)
    drops = [x for x in f.probe() if x.startswith("drop")]
    r.check("a screenshot dragged into an app arrives as its file", drops and pic["path"] in drops[0], drops)
    f.shell("Show")
    f.wait(lambda: f.state()["down"], 2)
    time.sleep(0.8)
    note = next(i for i in f.items() if i["kind"] == "note")
    x, y = f.center(note["id"])
    rig.t(f"move({x}, {y})", 0.4)
    rig.t("down()", 0.15)
    rig.t(f"glide([[{x}, {y}], [{x + 20}, {y + 30}], [600, 520]], 400)", 0.8)
    rig.t("move(602, 522)", 0.4)
    rig.t("up()", 1.0)
    drops = [x for x in f.probe() if x.startswith("drop")]
    r.check("a note dragged into an app arrives as text", drops and "drop text Shopping list" in drops[0], drops)
    f.leave(0.6)

    print("search")
    r.check("text in screenshots is read, for search", f.wait(lambda: any("olive" in (i.get("ocr") or "").lower() for i in f.items_full()), 15))
    rig.keys("Control_L", "Alt_L", "f", wait=1.0)
    r.check("Ctrl+Alt+F brings the line down to search", f.state()["down"] and f.state()["searching"], f.state())
    r.check("and gives it the keyboard", rig.js("global.display.focus_window === global._t.ext().keeper.window"))
    for ch in "tomat":
        rig.keys(ch, wait=0.08)
    time.sleep(0.6)
    f.shot("07-search")
    visible = [e for e in f.layout()]
    r.check("typing filters the line", len(visible) >= 1)
    rig.keys("Return", wait=1.2)
    r.check("Return copies the newest match", f.clipboard() == "Shopping list\nbread\nolive oil\ntomatoes", f.clipboard())
    r.check("and puts the line away", not f.state()["down"] and not f.state()["searching"])
    r.check("giving the keyboard back to the app", rig.js("global.display.focus_window?.get_title()") == "Probe", rig.js("global.display.focus_window?.get_title()"))
    rig.keys("Control_L", "Alt_L", "f", wait=0.8)
    for ch in "zzqx":
        rig.keys(ch, wait=0.06)
    time.sleep(0.4)
    rig.keys("Escape", wait=0.8)
    r.check("Esc ends a search", not f.state()["down"] and not f.state()["searching"])
    rig.keys("Control_L", "Alt_L", "j", wait=0.8)
    r.check("Ctrl+Alt+J brings the line down", f.state()["down"])
    rig.keys("Control_L", "Alt_L", "j", wait=0.8)
    r.check("and puts it away", not f.state()["down"])

    print("markup")
    f.shell("Show")
    f.wait(lambda: f.state()["down"], 2)
    time.sleep(0.8)
    pic = next(i for i in f.items() if i["kind"] == "screenshot")
    x, y = f.center(pic["id"])
    rig.t(f"move({x}, {y})", 0.4)
    rig.t("down()", 1.2)
    rig.t("up()", 1.2)
    titles = rig.js("global.display.list_all_windows().map(w => w.get_title())")
    r.check("press and hold opens Markup", "Markup" in titles, titles)
    f.shot("08-markup")
    r.check("and the line goes up out of its way", f.wait(lambda: not f.state()["down"], 3))
    rig.t("move(500, 400)", 0.2)
    rig.t("down()", 0.1)
    rig.t("glide([[500, 400], [600, 430], [700, 380]], 300)", 0.6)
    rig.t("up()", 0.3)
    rig.keys("Control_L", "Return", wait=1.5)
    items = f.items()
    marked = next((i for i in items if i["id"] == pic["id"]), None)
    r.check("Done saves a marked-up copy", marked and "(marked up)" in marked["path"] and pathlib.Path(marked["path"]).exists(), marked)
    r.check("and copies it", "image/png" in (f.clipboard_types() or []))
    r.check("the original screenshot is untouched", pathlib.Path(pic["path"]).exists())

    print("keeping")
    count = len(f.items())
    rig.js("global._t.ext().settings.set_int('max-items', 3); 1")
    r.check("only as many items as allowed stay", f.wait(lambda: len(f.items()) == 3, 3), len(f.items()))
    rig.js("global._t.ext().settings.reset('max-items'); 1")
    f.line("PutBack")
    r.check("the ones that fell off can be put back", f.wait(lambda: len(f.items()) == count, 3), len(f.items()))
    old = f.state()
    f.shell("Restart")
    r.check("the line restarts", f.wait(lambda: f.state()["running"], 10))
    r.check("and everything is still hanging", f.wait(lambda: len(f.items()) == count, 5), (len(f.items()), count))
    r.check("the shell finds the new window", f.wait(lambda: rig.js("!!global._t.ext().keeper.window && global._t.ext().keeper.window.is_above()"), 8))
    f.line("Clear")
    r.check("Take Everything Down empties the line", len(f.items()) == 0)
    r.check("and Put Back undoes it", "true" in f.line("PutBack") and len(f.items()) == count)
    void = old

    print("top bar")
    box = rig.js("(() => { const a = Main.panel.statusArea['%s']; const [x, y] = a.get_transformed_position(); return [x + a.width / 2, y + a.height / 2]; })()" % UUID)
    rig.t(f"move({box[0]}, {box[1]})")
    rig.t("click()", 0.8)
    r.check("clicking the clothespin brings the line down", f.state()["down"])
    rig.t("click()", 0.8)
    r.check("and puts it away", not f.state()["down"])
    rig.t("click(3)", 0.6)
    r.check("right-click opens its menu", rig.js("Main.panel.statusArea['%s'].menu.isOpen" % UUID))
    f.shot("09-menu")
    rig.keys("Escape", wait=0.4)

    print("the festoon command")
    cli = lambda *a, stdin=None: subprocess.run(["sh", str(ROOT / "bin/festoon"), *a], env=rig.env, input=stdin,
                                                capture_output=True, text=True, timeout=20)
    count = len(f.items())
    other = rig.tmp / "from the terminal.png"
    picture(other, 500, 500)
    r.check("festoon hang <file> hangs a picture", cli("hang", str(other)).returncode == 0 and f.items()[0]["path"] == str(other))
    r.check("festoon hang - hangs standard input as a note", cli("hang", "-", stdin="'quoted' 123\nand more\n").returncode == 0
            and f.items()[0]["kind"] == "note" and f.items()[0]["title"] == "'quoted' 123", f.items()[0])
    listed = cli("list").stdout.strip().split("\n")
    r.check("festoon list shows what hangs", len(listed) == count + 2 and listed[0].startswith("1\tnote"), listed[:3])
    r.check("festoon copy 1 copies the newest", cli("copy", "1").returncode == 0 and f.clipboard() == "'quoted' 123\nand more")
    r.check("festoon state is JSON", json.loads(cli("state").stdout)["count"] == count + 2)
    r.check("festoon show and hide", cli("show").returncode == 0 and f.wait(lambda: f.state()["down"], 2)
            and cli("hide").returncode == 0 and f.wait(lambda: not f.state()["down"], 2))
    r.check("festoon://putback links work", cli("letgo", "1").returncode == 0 and cli("festoon://putback").returncode == 0
            and len(f.items()) == count + 2)
    r.check("unknown items are refused with a reason", cli("copy", "99").returncode == 2)
    cli("letgo", "1")
    cli("letgo", "1")
    time.sleep(0.4)

    print("turning off")
    rig.js("Main.extensionManager.disableExtension('%s'); 1" % UUID)
    r.check("disabling the extension stops the line", f.wait(lambda: "ServiceUnknown" in f.line("GetState") or "not provided" in f.line("GetState"), 6))
    rig.t("move(1100, 120)")
    rig.t("click()")
    r.check("and nothing is left in the way", len(presses(f.probe())) == 1)
    rig.js("Main.extensionManager.enableExtension('%s'); 1" % UUID)
    r.check("enabling it again brings everything back", f.wait(lambda: f.state()["running"] and len(f.items()) == count, 12))


def main():
    keep = "--keep" in sys.argv
    if not PICTURE.exists():
        subprocess.run(["rsvg-convert", "-w", "800", "-h", "500", str(ROOT / "tests/picture.svg"), "-o", str(PICTURE)], check=True)
    OUT.mkdir(parents=True, exist_ok=True)
    pathlib.Path("/tmp/festoon-line-test.log").unlink(missing_ok=True)
    rig = Rig(UUID, ROOT / "extension", env={"FESTOON_LINE_LOG": "/tmp/festoon-line-test.log"})
    # a user theme that paints every window, as some do
    css = rig.home / ".config/gtk-4.0/gtk.css"
    css.parent.mkdir(parents=True)
    css.write_text("window.background, window.background.csd, .background { background-color: #212121; }\n")
    r = Results()
    try:
        rig.start()
        run(rig, r)
    finally:
        line_log = pathlib.Path("/tmp/festoon-line-test.log")
        errors = rig.errors("festoon")
        line_errors = [x for x in (line_log.read_text().split("\n") if line_log.exists() else [])
                       if "ERROR" in x or "CRITICAL" in x or "WARNING" in x]
        r.check("no errors from the shell side", errors == [], "\n".join(errors[:6]))
        r.check("no errors or warnings from the line", line_errors == [], "\n".join(line_errors[:6]))
        rig.stop(keep_tmp=keep)
        if keep:
            print(f"kept {rig.tmp}")
    print(f"\n{r.count - len(r.failed)}/{r.count} passed")
    sys.exit(1 if r.failed else 0)


if __name__ == "__main__":
    main()
