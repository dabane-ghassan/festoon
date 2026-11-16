"""A private, headless GNOME Shell for end-to-end tests.

Starts its own session bus and `gnome-shell --headless`, with a throwaway home folder, loads
one extension from a folder on disk, and gives the tests a virtual mouse and keyboard.
Nothing touches your own session or settings.
"""
import ast
import json
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import time

RIG_JS = """
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class Rig extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
"""

INPUT_JS = """
const Clutter = imports.gi.Clutter; const GLib = imports.gi.GLib;
const backend = Clutter.get_default_backend ? Clutter.get_default_backend() : global.stage.context.get_backend();
const seat = backend.get_default_seat();
const t = global._t = {};
t.v = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
t.k = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
t.now = () => GLib.get_monotonic_time();
t.move = (x, y) => t.v.notify_absolute_motion(t.now(), x, y);
t.down = (b = 1) => t.v.notify_button(t.now(), b, Clutter.ButtonState.PRESSED);
t.up = (b = 1) => t.v.notify_button(t.now(), b, Clutter.ButtonState.RELEASED);
t.click = (b = 1) => { t.down(b); t.up(b); };
t.wheel = dir => t.v.notify_discrete_scroll(t.now(), dir, Clutter.ScrollSource.WHEEL);
t.key = (keyval, down) => t.k.notify_keyval(t.now(), keyval, down ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
t.chord = (...keys) => { keys.forEach(k => t.key(k, true)); keys.slice().reverse().forEach(k => t.key(k, false)); };
t.glide = (pts, ms) => { const n = Math.max(2, Math.round(ms / 8)); let i = 0;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8, () => { const f = i / n * (pts.length - 1); const a = Math.min(pts.length - 2, Math.floor(f)); const u = f - a;
        t.move(pts[a][0] + (pts[a + 1][0] - pts[a][0]) * u, pts[a][1] + (pts[a + 1][1] - pts[a][1]) * u); return ++i <= n; }); };
t.ext = () => Main.extensionManager.lookup('%s').stateObj;
imports.gi.St.Settings.get().uninhibit_animations();
'ready'
"""


class Rig:
    def __init__(self, uuid, ext_dir, size="1280x800", env=None):
        self.uuid = uuid
        self.ext_dir = pathlib.Path(ext_dir)
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="festoon-test-"))
        self.env = dict(os.environ)
        home = self.tmp / "home"
        self.env.update({
            "HOME": str(home),
            "XDG_RUNTIME_DIR": str(self.tmp / "run"),
            "XDG_DATA_HOME": str(home / ".local/share"),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "XDG_SESSION_TYPE": "wayland", "XDG_CURRENT_DESKTOP": "GNOME",
            "GSETTINGS_BACKEND": "keyfile", "LIBGL_ALWAYS_SOFTWARE": "1",
            "NO_AT_BRIDGE": "1", "GTK_A11Y": "none", "LANG": "C.UTF-8",
        })
        self.env.update(env or {})
        self.env.pop("DBUS_SESSION_BUS_ADDRESS", None)
        self.env.pop("WAYLAND_DISPLAY", None)
        self.env.pop("DISPLAY", None)
        for d in ("home", "run"):
            (self.tmp / d).mkdir()
        (self.tmp / "run").chmod(0o700)
        self.home = home
        self.size = size
        self.procs = []
        self.log = self.tmp / "shell.log"

    @property
    def installed(self):
        return self.home / ".local/share/gnome-shell/extensions" / self.uuid

    def start(self):
        exts = self.home / ".local/share/gnome-shell/extensions"
        (exts / "rig@test").mkdir(parents=True)
        (exts / "rig@test/metadata.json").write_text(json.dumps({
            "uuid": "rig@test", "name": "rig", "description": "lets the tests drive the shell",
            "shell-version": [self.shell_major()]}))
        (exts / "rig@test/extension.js").write_text(RIG_JS)
        shutil.copytree(self.ext_dir, exts / self.uuid)
        if (exts / self.uuid / "schemas").is_dir():
            subprocess.run(["glib-compile-schemas", str(exts / self.uuid / "schemas")], check=True)

        bus = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--print-address=1"],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=self.env, text=True)
        self.procs.append(bus)
        self.env["DBUS_SESSION_BUS_ADDRESS"] = bus.stdout.readline().strip()
        gs = ["gsettings", "set", "org.gnome.shell"]
        subprocess.run(gs + ["enabled-extensions", f"['rig@test', '{self.uuid}']"], env=self.env, check=True)
        subprocess.run(gs + ["disable-user-extensions", "false"], env=self.env, check=True)
        subprocess.run(gs + ["welcome-dialog-last-shown-version", "99.0"], env=self.env, check=True)
        # the container runs as root, which GNOME warns about in a banner over everything
        subprocess.run(["gsettings", "set", "org.gnome.desktop.notifications", "show-banners", "false"], env=self.env, check=True)

        shell = subprocess.Popen(
            ["gnome-shell", "--headless", "--wayland", "--no-x11", "--virtual-monitor", self.size],
            stdout=open(self.log, "w"), stderr=subprocess.STDOUT, env=self.env)
        self.procs.append(shell)
        self.shell = shell
        self.env["WAYLAND_DISPLAY"] = "wayland-0"
        deadline = time.time() + 40
        while time.time() < deadline:
            if shell.poll() is not None:
                raise SystemExit(f"gnome-shell exited early:\n{self.log.read_text()[-3000:]}")
            r = subprocess.run(["gdbus", "call", "--session", "-d", "org.gnome.Shell", "-o", "/org/gnome/Shell",
                                "-m", "org.freedesktop.DBus.Properties.Get", "org.gnome.Shell", "ShellVersion"],
                               env=self.env, capture_output=True, text=True)
            if r.returncode == 0:
                break
            time.sleep(0.3)
        else:
            raise SystemExit("gnome-shell did not come up")
        time.sleep(2)
        self.js("Main.overview.hide(); 1")
        time.sleep(0.8)
        assert "ready" in self.js(INPUT_JS % self.uuid)

    @staticmethod
    def shell_major():
        out = subprocess.run(["gnome-shell", "--version"], capture_output=True, text=True).stdout
        return out.split()[-1].split(".")[0]

    def stop(self, keep_tmp=False):
        for p in reversed(self.procs):
            try:
                p.send_signal(signal.SIGTERM)
            except ProcessLookupError:
                pass
        for p in self.procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
        if not keep_tmp:
            shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers ------------------------------------------------------------

    def js(self, code):
        r = subprocess.run(["gdbus", "call", "--session", "-d", "org.gnome.Shell", "-o", "/org/gnome/Shell",
                            "-m", "org.gnome.Shell.Eval", code], env=self.env, capture_output=True, text=True)
        out = r.stdout.strip()
        if not out.startswith("(true"):
            raise RuntimeError(f"shell eval failed: {out or r.stderr}\n  code: {code[:300]}")
        inner = ast.literal_eval(out[len("(true, "):-1])
        return json.loads(inner) if inner else None

    def t(self, call, wait=0.25):
        self.js(f"global._t.{call}; 1")
        time.sleep(wait)

    def keys(self, *names, wait=0.4):
        self.js("const C = imports.gi.Clutter; global._t.chord(%s); 1" % ", ".join(f"C.KEY_{n}" for n in names))
        time.sleep(wait)

    def gdbus(self, dest, obj, method, *args, timeout=5):
        r = subprocess.run(["gdbus", "call", "--session", "-d", dest, "-o", obj, "-m", method, *args],
                           env=self.env, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() or r.stderr.strip()

    def shot(self, path):
        path = pathlib.Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
        subprocess.run(["gdbus", "call", "--session", "-d", "org.gnome.Shell.Screenshot",
                        "-o", "/org/gnome/Shell/Screenshot", "-m", "org.gnome.Shell.Screenshot.Screenshot",
                        "false", "false", str(path)], env=self.env, capture_output=True)
        return path

    def spawn(self, argv, log=None):
        p = subprocess.Popen(argv, env=self.env, stdout=open(log, "w") if log else subprocess.DEVNULL,
                             stderr=subprocess.STDOUT if log else subprocess.DEVNULL)
        self.procs.append(p)
        return p

    def shell_log(self):
        return self.log.read_text()

    def errors(self, word):
        return [line for line in self.shell_log().split("\n")
                if "JS ERROR" in line or ("CRITICAL" in line and word in line.lower())
                or (word in line.lower() and "error" in line.lower())]
