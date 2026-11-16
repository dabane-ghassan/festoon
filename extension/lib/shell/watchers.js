// What GNOME Shell notices for the line: the pointer resting on the top bar, the clipboard
// changing, and the "Screenshot captured" notification (which can be skipped).

import Clutter from 'gi://Clutter';
import Gettext from 'gettext';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PointerWatcher from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK;

/** Brings the line down when the pointer rests on the top bar. */
export class TopBarWatcher {
    constructor(settings, keeper, indicator = () => null) {
        this._settings = settings;
        this._keeper = keeper;
        this._indicator = indicator;
        this._inside = false;
        this._dwell = 0;
        this._watch = PointerWatcher.getPointerWatcher().addWatch(50, (x, y) => this._moved(x, y));
        this._overview = Main.overview.connect('showing', () => keeper.tuck());
    }

    _onPanel(x, y) {
        const box = Main.layoutManager.panelBox;
        if (!box.visible || Main.layoutManager.primaryMonitor?.inFullscreen)
            return false;
        const [bx, by] = box.get_transformed_position();
        return x >= bx && x < bx + box.width && y >= by && y < by + box.height;
    }

    /** Resting on a button (the clock, the system menu) is about that button, not the line. */
    _onButton(x, y) {
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        const own = this._indicator();
        while (actor && actor !== Main.panel) {
            if (actor === own)
                return false;
            if (actor.has_style_class_name?.('panel-button'))
                return true;
            actor = actor.get_parent();
        }
        return false;
    }

    _eligible(x, y) {
        if (!this._settings.get_boolean('reveal-on-hover') || Main.overview.visible || Main.modalCount > 0)
            return false;
        if (Main.panel.menuManager.activeMenu)
            return false;
        const [, , mods] = global.get_pointer();
        if (mods & BUTTONS)
            return false;       // dragging a window to the top, say
        const top = Main.layoutManager.panelBox.get_transformed_position()[1];
        return y <= top + 1 || !this._onButton(x, y);
    }

    _moved(x, y) {
        const inside = this._onPanel(x, y);
        if (inside !== this._inside) {
            this._inside = inside;
            this._keeper.panelHover(inside);
        }
        if (this._dwell)
            GLib.source_remove(this._dwell);
        this._dwell = 0;
        if (Main.panel.menuManager.activeMenu) {
            this._keeper.tuck();
            return;
        }
        if (!inside || this._keeper.state?.down)
            return;
        this._dwell = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(30, this._settings.get_int('reveal-delay')), () => {
            this._dwell = 0;
            const [px, py] = global.get_pointer();
            if (this._onPanel(px, py) && this._eligible(px, py))
                this._keeper.reveal('hover');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._dwell)
            GLib.source_remove(this._dwell);
        this._dwell = 0;
        this._watch?.remove?.();
        this._watch = null;
        Main.overview.disconnect(this._overview);
    }
}

const TEXT = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
const IMAGES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'];
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic)$/i;
const MAX_TEXT = 256 * 1024;
const MAX_IMAGE = 40 * 1024 * 1024;

/** Hangs what you copy. Skips password managers' secrets and Festoon's own copies. */
export class ClipboardWatcher {
    constructor(settings, keeper) {
        this._settings = settings;
        this._keeper = keeper;
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._id = this._selection.connect('owner-changed', (_s, type, source) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._changed(source);
        });
        this._incoming = GLib.build_filenamev([GLib.get_user_cache_dir(), 'festoon', 'incoming']);
    }

    _changed(source) {
        if (!source)
            return;
        // Copies made inside the shell (Festoon's own, the screenshot tool's, the clipboard
        // keeper after an app quits) are memory sources. Screenshots arrive as files instead.
        if (source instanceof Meta.SelectionSourceMemory)
            return;
        const mimes = source.get_mimetypes();
        if (mimes.includes('x-kde-passwordManagerHint'))
            return;
        const s = this._settings;
        const files = mimes.includes('text/uri-list') || mimes.includes('x-special/gnome-copied-files');
        const text = TEXT.find(m => mimes.includes(m));
        const image = IMAGES.find(m => mimes.includes(m));

        if (files) {
            if (!s.get_boolean('hang-images'))
                return;
            const mime = mimes.includes('text/uri-list') ? 'text/uri-list' : 'x-special/gnome-copied-files';
            this._read(mime, bytes => {
                const lines = new TextDecoder().decode(bytes.toArray()).split(/\r?\n/);
                for (const line of lines) {
                    if (!line.startsWith('file://'))
                        continue;
                    const path = Gio.File.new_for_uri(line.trim()).get_path();
                    if (path && IMAGE_FILE.test(path))
                        this._keeper.call('HangFile', path, 'file');
                }
            });
            return;
        }
        if (text) {
            if (!s.get_boolean('hang-text') && !s.get_boolean('hang-links'))
                return;
            this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, value) => {
                if (value && value.trim() && value.length <= MAX_TEXT)
                    this._keeper.call('HangText', value);
            });
            return;
        }
        if (image && s.get_boolean('hang-images')) {
            this._read(image, bytes => {
                if (!bytes.get_size() || bytes.get_size() > MAX_IMAGE)
                    return;
                GLib.mkdir_with_parents(this._incoming, 0o700);
                const ext = image.split('/')[1].replace('jpeg', 'jpg');
                const path = GLib.build_filenamev([this._incoming, `copied-${Date.now()}.${ext}`]);
                const file = Gio.File.new_for_path(path);
                file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, null, (_f, res) => {
                    try {
                        file.replace_contents_finish(res);
                        this._keeper.call('HangFile', path, 'clipboard-image');
                    } catch (e) {
                        console.warn(`Festoon: could not keep a copied image: ${e.message}`);
                    }
                });
            });
        }
    }

    _read(mime, done) {
        this._clipboard.get_content(St.ClipboardType.CLIPBOARD, mime, (_c, bytes) => {
            if (bytes)
                done(bytes);
        });
    }

    destroy() {
        this._selection.disconnect(this._id);
    }
}

/** Optionally skips the "Screenshot captured" banner: the screenshot is on the line instead. */
export class ScreenshotQuieter {
    constructor(settings) {
        this._settings = settings;
        this._title = Gettext.dgettext('gnome-shell', 'Screenshot');
        this._id = Main.messageTray.connect('source-added', (_t, source) => {
            if (source.iconName !== 'screenshot-recorded-symbolic' || source.title !== this._title)
                return;
            source.connectObject?.('notification-added', (_s, notification) => {
                if (!this._settings.get_boolean('quiet-screenshots'))
                    return;
                notification.acknowledged = true;       // no banner
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    notification.destroy();
                    return GLib.SOURCE_REMOVE;
                });
            }, this);
        });
    }

    destroy() {
        Main.messageTray.disconnect(this._id);
        for (const source of Main.messageTray.getSources?.() ?? [])
            source.disconnectObject?.(this);
    }
}
