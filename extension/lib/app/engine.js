// Talks to the line (its own process) and to the shell side, for the Festoon window.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {LINE_ID, LINE_IFACE, LINE_PATH, SHELL_IFACE, SHELL_PATH, UUID} from '../common.js';

export class Engine {
    constructor() {
        this._bus = Gio.DBus.session;
        this.state = null;      // null until the line answers
        this.items = [];
        this._watchers = [];
        this._signal = this._bus.signal_subscribe(null, LINE_IFACE, 'StateChanged', LINE_PATH, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => this._set(params.deep_unpack()[0]));
        this._owner = Gio.bus_watch_name(Gio.BusType.SESSION, LINE_ID, Gio.BusNameWatcherFlags.NONE,
            () => this.refresh(), () => this._set(null));
        this._tries = 0;
        this._retry = 0;
        this.refresh();
    }

    _set(json) {
        try {
            this.state = json === null ? null : JSON.parse(json);
        } catch (_e) {
            this.state = null;
        }
        if (this.state) {
            this._call(LINE_PATH, LINE_IFACE, LINE_ID, 'GetItems', null, result => {
                try {
                    this.items = JSON.parse(result.deep_unpack()[0]);
                } catch (_e) {
                    this.items = [];
                }
                this._notify();
            });
        } else {
            this.items = [];
            this._notify();
        }
    }

    _notify() {
        for (const w of this._watchers)
            w(this.state, this.items);
    }

    refresh() {
        this._call(LINE_PATH, LINE_IFACE, LINE_ID, 'GetState', null, result => this._set(result.deep_unpack()[0]), () => {
            this._set(null);
            if (this._tries === 0)
                this._enable();
            if (this._tries++ < 8 && !this._retry) {
                this._retry = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    this._retry = 0;
                    this.refresh();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    _enable() {
        // harmless if it is already enabled, or if GNOME has not seen the files yet
        try {
            Gio.Subprocess.new(['gnome-extensions', 'enable', UUID],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (_e) {
            // not a GNOME session
        }
    }

    _call(path, iface, dest, method, params, ok = null, fail = null) {
        this._bus.call(dest, path, iface, method, params, null, Gio.DBusCallFlags.NO_AUTO_START, 3000, null, (bus, res) => {
            let result;
            try {
                result = bus.call_finish(res);
            } catch (_e) {
                fail?.();
                return;
            }
            ok?.(result);
        });
    }

    /** A method of the line: PutBack, Clear, Copy, LetGo... */
    line(method, arg = null) {
        this._call(LINE_PATH, LINE_IFACE, LINE_ID, method, arg === null ? null : new GLib.Variant('(s)', [arg]));
    }

    /** A method of the shell side: Show, Toggle, Search (it hands the keyboard to the line). */
    shell(method) {
        this._call(SHELL_PATH, SHELL_IFACE, 'org.gnome.Shell', method, null);
    }

    watch(callback) {
        this._watchers.push(callback);
        callback(this.state, this.items);
    }

    destroy() {
        this._watchers = [];
        if (this._signal)
            this._bus.signal_unsubscribe(this._signal);
        this._signal = 0;
        if (this._owner)
            Gio.bus_unwatch_name(this._owner);
        this._owner = 0;
        if (this._retry)
            GLib.source_remove(this._retry);
        this._retry = 0;
    }
}
