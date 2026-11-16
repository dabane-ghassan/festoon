// Starts the line's process, keeps its window on top of everything just under the top bar
// (on every workspace, out of the overview and Alt+Tab), restarts it if it stops, and gives
// keyboard focus back to your window when the line goes up.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LINE_ID, LINE_PATH, LINE_XML, lineHeight} from '../common.js';

const LineProxy = Gio.DBusProxy.makeProxyWrapper(LINE_XML);
const MAX_RESTARTS = 5;

export class Keeper {
    constructor(extensionPath, settings) {
        this._path = extensionPath;
        this._settings = settings;
        this._client = null;
        this._proc = null;
        this._window = null;
        this._lastFocus = null;
        this._restarts = [];
        this._stopping = false;
        this.state = null;              // the line's last StateChanged
        this.onState = null;            // (state) => void
        this.onEvent = null;            // (name) => void
        this._signals = [];

        // Placing a window as it is created crashes some versions of Mutter: wait until it is
        // on screen, then do it from an idle callback.
        this._connect(global.window_manager, 'map', (_wm, actor) => {
            const win = actor.meta_window;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._maybeAdopt(win);
                return GLib.SOURCE_REMOVE;
            });
        });
        this._connect(global.display, 'notify::focus-window', () => {
            const focus = global.display.focus_window;
            if (focus && focus !== this._window)
                this._lastFocus = focus;
        });
        this._connect(Main.layoutManager, 'monitors-changed', () => this._place());
        this._connect(Main.layoutManager.panelBox, 'notify::height', () => this._place());
        this._connect(settings, 'changed::size', () => this._place());

        this._proxy = null;
        new LineProxy(Gio.DBus.session, LINE_ID, LINE_PATH, (proxy, error) => {
            if (error) {
                console.warn(`Festoon: ${error.message}`);
                return;
            }
            if (this._stopping)
                return;
            this._proxy = proxy;
            this._proxySignals = [
                proxy.connectSignal('StateChanged', (_p, _s, [json]) => this._onState(json)),
                proxy.connectSignal('Event', (_p, _s, [name]) => this.onEvent?.(name)),
            ];
            // ask for the state whenever a (new) line appears on the bus
            this._ownerId = proxy.connect('notify::g-name-owner', () => this._fetch());
            this._fetch();
        }, null, Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES);

        this._spawn();
    }

    _connect(obj, signal, fn) {
        this._signals.push([obj, obj.connect(signal, fn)]);
    }

    // ------------------------------------------------------------- the process

    _spawn() {
        const argv = ['gjs', '-m', GLib.build_filenamev([this._path, 'line.js'])];
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        launcher.setenv('GDK_BACKEND', 'wayland', true);
        const log = GLib.getenv('FESTOON_LINE_LOG');     // for the tests
        if (log) {
            launcher.set_stdout_file_path(log);
            launcher.set_flags(Gio.SubprocessFlags.STDERR_MERGE);
        }
        try {
            if (!Meta.is_wayland_compositor()) {
                // X11 session: an ordinary process, found again by its pid
                launcher.setenv('GDK_BACKEND', 'x11', true);
                this._client = null;
                this._proc = launcher.spawnv(argv);
            } else if (Meta.WaylandClient.new_subprocess) {
                // GNOME 49 and later
                this._client = Meta.WaylandClient.new_subprocess(global.context, launcher, argv);
                this._proc = this._client.get_subprocess();
            } else {
                this._client = Meta.WaylandClient.new(global.context, launcher);
                this._proc = this._client.spawnv(global.display, argv);
            }
        } catch (e) {
            console.error(`Festoon: could not start the line: ${e.message}`);
            return;
        }
        const proc = this._proc;
        proc.wait_async(null, () => {
            if (proc !== this._proc)
                return;
            this._proc = null;
            this._window = null;
            this.state = null;
            this.onState?.(null);
            if (this._stopping)
                return;
            const now = GLib.get_monotonic_time();
            this._restarts = this._restarts.filter(t => now - t < 60e6);
            if (this._restarts.length >= MAX_RESTARTS) {
                console.error('Festoon: the line keeps stopping; not restarting it again until next login');
                return;
            }
            this._restarts.push(now);
            this._respawnId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                this._respawnId = 0;
                this._spawn();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    restart() {
        this._restarts = [];
        if (this._proc)
            this._proc.force_exit();
        else
            this._spawn();
    }

    _owns(win) {
        if (this._client)
            return this._client.owns_window(win);
        const pid = this._proc?.get_identifier();
        return !!pid && String(win.get_pid()) === pid;
    }

    _maybeAdopt(win) {
        if (!win || win === this._window || !this._owns(win))
            return;
        // Markup, a note or Quick Look: opened by a gesture on the line, so it gets the keyboard
        // (Wayland would otherwise only say it "is ready")
        if (win.get_title() !== 'Festoon' || win.get_transient_for() || this._window) {
            Main.activateWindow(win);
            return;
        }
        this._window = win;
        this._client?.hide_from_window_list?.(win);
        win.make_above();
        win.stick();
        this._place();
        // a new window gets the keyboard; the line should not take it from you at login
        this._giveFocusBack();
        win.connect('unmanaged', () => {
            if (this._window === win)
                this._window = null;
        });
    }

    get window() {
        return this._window;
    }

    _place() {
        const win = this._window;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!win || !monitor)
            return;
        const panel = Main.layoutManager.panelBox;
        const top = panel.visible ? panel.y + panel.height : monitor.y;
        const height = lineHeight(this._settings.get_string('size'));
        win.move_resize_frame(false, monitor.x, top, monitor.width, height);
    }

    // ------------------------------------------------------------- talking to it

    _onState(json) {
        let state = null;
        try {
            state = JSON.parse(json);
        } catch (_e) {
            return;
        }
        const wasDown = this.state?.down;
        this.state = state;
        if (wasDown && !state.down)
            this._giveFocusBack();
        this.onState?.(state);
    }

    _fetch() {
        if (!this._proxy?.g_name_owner)
            return;
        this._proxy.GetStateRemote((result, error) => {
            if (!error && result)
                this._onState(result[0]);
        });
    }

    /** The line went up: if it had the keyboard, hand it back to the window you were using. */
    _giveFocusBack() {
        const win = this._window;
        if (!win || global.display.focus_window !== win)
            return;
        const time = global.get_current_time();
        const last = this._lastFocus;
        const workspace = global.workspace_manager.get_active_workspace();
        if (last && last !== win && !last.minimized && last.get_workspace?.() === workspace && last.get_compositor_private())
            last.activate(time);
        else
            global.display.unset_input_focus(time);
    }

    call(method, ...args) {
        if (!this._proxy)
            return;
        this._proxy[`${method}Remote`](...args, (_result, error) => {
            if (error && !error.message?.includes('ServiceUnknown'))
                console.debug(`Festoon: ${method}: ${error.message}`);
        });
    }

    reveal(reason) {
        this.call('Reveal', reason);
    }

    tuck() {
        if (this.state?.down)
            this.call('Tuck');
    }

    toggle() {
        this.call('Toggle');
    }

    search() {
        this.call('Search');
        // the line needs the keyboard to type into
        const activate = () => {
            if (this._window)
                Main.activateWindow(this._window);
            return GLib.SOURCE_REMOVE;
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, activate);
    }

    panelHover(inside) {
        this.call('PanelHover', inside);
    }

    destroy() {
        this._stopping = true;
        if (this._respawnId)
            GLib.source_remove(this._respawnId);
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        if (this._proxy) {
            for (const id of this._proxySignals ?? [])
                this._proxy.disconnectSignal(id);
            if (this._ownerId)
                this._proxy.disconnect(this._ownerId);
        }
        if (this._proc) {
            // ask nicely, then make sure
            this.call('Quit');
            const proc = this._proc;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                if (!proc.get_if_exited?.())
                    proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._proc = null;
        this._client = null;
        this._window = null;
        this._proxy = null;
    }
}
