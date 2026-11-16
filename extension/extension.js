// Festoon: your screenshots and the things you copy, hung on a line under the top bar.
// https://github.com/dabane-ghassan/festoon
//
// This is the part that runs inside GNOME Shell. It starts the line (line.js, its own small GTK
// process) and keeps its window on top, brings it down when the pointer rests on the top bar,
// passes it what you copy, and adds the clothespin to the top bar.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SHELL_PATH, SHELL_XML} from './lib/common.js';
import {Keeper} from './lib/shell/keeper.js';
import {ClipboardWatcher, ScreenshotQuieter, TopBarWatcher} from './lib/shell/watchers.js';

const SHORTCUTS = ['show-shortcut', 'search-shortcut'];

const HANG = [
    ['hang-screenshots', 'Screenshots'],
    ['hang-recordings', 'Screen recordings'],
    ['hang-images', 'Copied images'],
    ['hang-text', 'Copied text'],
    ['hang-links', 'Copied links'],
];

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Festoon');
        this._ext = ext;
        const icons = GLib.build_filenamev([ext.path, 'assets', 'icons']);
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(GLib.build_filenamev([icons, 'festoon-symbolic.svg'])),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);
        this._buildMenu();

        // Left click brings the line down or puts it away; right or middle click opens the menu.
        if (this._clickGesture && Clutter.ClickGesture) {
            this._clickGesture.set_enabled(false);
            const gesture = new Clutter.ClickGesture();
            gesture.set_recognize_on_press(true);
            gesture.connect('recognize', () => {
                if (gesture.get_button() > Clutter.BUTTON_PRIMARY)
                    this.menu.toggle();
                else if (this.menu.isOpen)
                    this.menu.close();
                else
                    this._ext.keeper.toggle();
            });
            this.add_action(gesture);
            this._ownGesture = gesture;
        }
    }

    vfunc_event(event) {
        if (this._ownGesture)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) {
            if (this.menu.isOpen)
                this.menu.close();
            else
                this._ext.keeper.toggle();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.TOUCH_BEGIN) {
            this._ext.keeper.toggle();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS) {
            this.menu.toggle();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _buildMenu() {
        const {keeper, settings} = this._ext;
        this._show = this.menu.addAction('Show the Line', () => keeper.toggle());
        this._search = this.menu.addAction('Search…', () => keeper.search());
        this._back = this.menu.addAction('Put Back', () => keeper.call('PutBack'));
        this._clear = this.menu.addAction('Take Everything Down', () => keeper.call('Clear'));
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const hang = new PopupMenu.PopupSubMenuMenuItem('Hang', false);
        this._switches = [];
        for (const [key, label] of HANG) {
            const item = new PopupMenu.PopupSwitchMenuItem(label, settings.get_boolean(key));
            item.connect('toggled', (_i, on) => settings.set_boolean(key, on));
            hang.menu.addMenuItem(item);
            this._switches.push([key, item]);
        }
        this.menu.addMenuItem(hang);
        this._hover = new PopupMenu.PopupSwitchMenuItem('Come Down on Hover', settings.get_boolean('reveal-on-hover'));
        this._hover.connect('toggled', (_i, on) => settings.set_boolean('reveal-on-hover', on));
        this.menu.addMenuItem(this._hover);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Festoon Settings…', () => this._ext.openApp());
        this.menu.connect('open-state-changed', (_m, open) => open && this.sync());
    }

    _accel(key) {
        const accel = this._ext.settings.get_strv(key)[0];
        if (!accel)
            return '';
        return accel.replace(/<Control>|<Primary>/g, 'Ctrl+').replace('<Alt>', 'Alt+').replace('<Super>', 'Super+')
            .replace('<Shift>', 'Shift+').replace(/\+([a-z])$/, (_m, k) => `+${k.toUpperCase()}`);
    }

    sync() {
        const {keeper, settings} = this._ext;
        const state = keeper.state;
        const running = !!state;
        this._show.label.text = state?.down ? 'Put the Line Away' : 'Show the Line';
        const keys = this._accel('show-shortcut');
        this._show.label.text += keys ? `  (${keys})` : '';
        const searchKeys = this._accel('search-shortcut');
        this._search.label.text = searchKeys ? `Search…  (${searchKeys})` : 'Search…';
        for (const item of [this._show, this._search])
            item.setSensitive(running);
        this._back.setSensitive(running && !!state.canPutBack);
        this._clear.setSensitive(running && state.count > 0);
        this._clear.label.text = running && state.count ? `Take Everything Down (${state.count})` : 'Take Everything Down';
        for (const [key, item] of this._switches)
            item.setToggleState(settings.get_boolean(key));
        this._hover.setToggleState(settings.get_boolean('reveal-on-hover'));
        if (state?.down)
            this.add_style_pseudo_class('checked');
        else
            this.remove_style_pseudo_class('checked');
    }
});

export default class FestoonExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.keeper = new Keeper(this.path, this.settings);
        this._clipboard = new ClipboardWatcher(this.settings, this.keeper);
        this._quieter = new ScreenshotQuieter(this.settings);
        this._topBar = new TopBarWatcher(this.settings, this.keeper, () => this._indicator);

        this.keeper.onState = () => this._indicator?.sync();
        this.keeper.onEvent = name => this._sound(name);

        this._syncIndicator();
        this._indicatorId = this.settings.connect('changed::show-indicator', () => this._syncIndicator());

        const handlers = {
            'show-shortcut': () => this.keeper.toggle(),
            'search-shortcut': () => this.keeper.search(),
        };
        for (const name of SHORTCUTS) {
            Main.wm.addKeybinding(name, this.settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, handlers[name]);
        }

        this._dbus = Gio.DBusExportedObject.wrapJSObject(SHELL_XML, this);
        this._dbus.export(Gio.DBus.session, SHELL_PATH);
    }

    _syncIndicator() {
        const want = this.settings.get_boolean('show-indicator');
        if (want && !this._indicator) {
            this._indicator = new Indicator(this);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
            this._indicator.sync();
        } else if (!want && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    _sound(name) {
        if (!this.settings.get_boolean('sounds'))
            return;
        const file = Gio.File.new_for_path(GLib.build_filenamev([this.path, 'assets', 'sounds', `${name}.wav`]));
        if (!file.query_exists(null))
            return;
        try {
            global.display.get_sound_player().play_from_file(file, 'Festoon', null);
        } catch (_e) {
            // no sound
        }
    }

    /** Open the Festoon window; fall back to GNOME's own settings dialog if gjs cannot start it. */
    openApp() {
        try {
            Gio.Subprocess.new(['gjs', '-m', GLib.build_filenamev([this.path, 'app.js'])], Gio.SubprocessFlags.NONE);
        } catch (_e) {
            this.openPreferences();
        }
    }

    // ------------------------------------------------------------- D-Bus, for the line and the command

    /** The line asks the shell to copy: Wayland only lets the focused app set the clipboard. */
    SetClipboard(mime, value, isPath) {
        const clipboard = St.Clipboard.get_default();
        if (mime.startsWith('text/plain') && !isPath) {
            clipboard.set_text(St.ClipboardType.CLIPBOARD, value);
            return;
        }
        let bytes;
        if (isPath)
            bytes = new GLib.Bytes(GLib.file_get_contents(value)[1]);
        else
            bytes = new GLib.Bytes(new TextEncoder().encode(value));
        clipboard.set_content(St.ClipboardType.CLIPBOARD, mime, bytes);
    }

    Show() {
        this.keeper.reveal('shortcut');
    }

    Hide() {
        this.keeper.call('Tuck');
    }

    Toggle() {
        this.keeper.toggle();
    }

    Search() {
        this.keeper.search();
    }

    Restart() {
        this.keeper.restart();
    }

    GetState() {
        return JSON.stringify({
            version: this.metadata['version-name'],
            line: this.keeper.state,
            window: !!this.keeper.window,
        });
    }

    disable() {
        // Also runs when the screen locks: the line goes away with it and comes back on unlock.
        this._dbus?.unexport();
        this._dbus = null;
        for (const name of SHORTCUTS)
            Main.wm.removeKeybinding(name);
        if (this._indicatorId)
            this.settings.disconnect(this._indicatorId);
        this._indicatorId = 0;
        this._topBar.destroy();
        this._topBar = null;
        this._clipboard.destroy();
        this._clipboard = null;
        this._quieter.destroy();
        this._quieter = null;
        this.keeper.onState = null;
        this.keeper.onEvent = null;
        this.keeper.destroy();
        this.keeper = null;
        this._indicator?.destroy();
        this._indicator = null;
        this.settings = null;
    }
}
