// The line's controller: the window, what hangs on it, when it comes down and goes back up,
// and what each gesture does.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {LINE_PATH, LINE_XML, SHELL_IFACE, SHELL_PATH, lineHeight} from '../common.js';
import {captureFolders, readVersion} from '../settings.js';
import {MarkupWindow, NoteWindow, QuickLook} from './editors.js';
import {Folders, isImage, isVideo} from './folders.js';
import {Reader} from './ocr.js';
import {Store} from './store.js';
import {LineView} from './view.js';

const CSS = `
window.festoon-line, window.festoon-line.background, window.festoon-line.csd,
window.festoon-line > *, window.festoon-line > * > * { background: none; background-color: transparent; background-image: none; box-shadow: none; border: none; }
.festoon-search {
    background: rgba(27, 26, 23, 0.94);
    color: #F4EDE0;
    border-radius: 999px;
    padding: 4px 6px 4px 12px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(244, 237, 224, 0.16);
}
.festoon-search entry, .festoon-search text { background: none; color: #F4EDE0; box-shadow: none; outline: none; min-height: 30px; }
.festoon-search image { color: rgba(244, 237, 224, 0.7); }
.festoon-search .festoon-count { color: rgba(244, 237, 224, 0.6); font-size: 0.86em; margin: 0 8px; font-feature-settings: "tnum"; }
`;

const TUCK_AFTER = 320;
const PEEK_FOR = 1900;

const bytesOf = s => new GLib.Bytes(new TextEncoder().encode(s));

export class Line {
    constructor(app, extensionDir, settings) {
        this._app = app;
        this._dir = extensionDir;
        this._settings = settings;
        this.version = readVersion(extensionDir) ?? '0';
        this.store = new Store();
        this.store.max = settings.get_int('max-items');
        this.store.trim(false);
        this._reader = new Reader();
        this._down = false;
        this._reason = '';
        this._inside = false;
        this._panel = false;
        this._touched = false;
        this._busy = new Set();
        this._timer = 0;
        this._region = null;
        this._editors = new Map();

        this._buildWindow();
        this.store.onChanged = (what, item) => this._storeChanged(what, item);
        this.view.setItems(this.store.items);

        this._folders = new Folders(settings, (path, kind) => this._fileArrived(path, kind));
        this._settingIds = [
            settings.connect('changed::max-items', () => {
                this.store.max = settings.get_int('max-items');
                this.store.trim();
            }),
        ];
        this._pruneId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 30, () => {
            this.store.prune();
            return GLib.SOURCE_CONTINUE;
        });

        this._shell = null;
        Gio.DBusProxy.new(Gio.DBus.session, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS,
            null, 'org.gnome.Shell', SHELL_PATH, SHELL_IFACE, null, (_o, res) => {
                try {
                    this._shell = Gio.DBusProxy.new_finish(res);
                } catch (_e) {
                    this._shell = null;
                }
            });

        this._dbus = Gio.DBusExportedObject.wrapJSObject(LINE_XML, this);
        this._dbus.export(app.get_dbus_connection(), LINE_PATH);
        this._emit();       // the shell side may have asked before this object was there
    }

    // ------------------------------------------------------------- window

    _buildWindow() {
        const provider = new Gtk.CssProvider();
        if (provider.load_from_string)
            provider.load_from_string(CSS);
        else
            provider.load_from_data(CSS, -1);
        // Above the user's own ~/.config/gtk-4.0/gtk.css too: a theme that paints every window
        // must not paint this one, which has to stay see-through.
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_USER + 10);

        const win = new Gtk.Window({
            application: this._app, title: 'Festoon', decorated: false, resizable: true,
            default_width: 1280, default_height: lineHeight(this._settings.get_string('size')),
        });
        // add_css_class, not css_classes: replacing GTK's own classes keeps the window from showing
        win.add_css_class('festoon-line');
        this.window = win;
        this.view = new LineView(this._settings, this._dir);
        this.view.onAction = (action, item, extra) => this.act(action, item, extra);
        this.view.onPointer = inside => {
            this._inside = inside;
            if (inside)
                this._touched = true;
            this._evaluate();
        };
        this.view.onDrag = (dragging, _item) => {
            this._setBusy('drag', dragging);
            if (!dragging && !this._inside)
                this._evaluate(true);
        };
        this.view.contentFor = item => this._content(item);
        this.view.onFrame = () => this._syncRegion();

        // search, at the right end of the line
        this._search = new Gtk.SearchEntry({placeholder_text: 'Search the line', width_chars: 22, hexpand: true});
        this._count = new Gtk.Label({css_classes: ['festoon-count']});
        const box = new Gtk.Box({css_classes: ['festoon-search'], halign: Gtk.Align.END, valign: Gtk.Align.START,
            margin_top: 10, margin_end: 40, visible: false});
        box.append(this._search);
        box.append(this._count);
        this._searchBox = box;
        this._search.connect('search-changed', () => this._filter());
        this._search.connect('activate', () => this._copyFirstMatch());
        this._search.connect('stop-search', () => this.Tuck());

        const overlay = new Gtk.Overlay({child: this.view});
        overlay.add_overlay(box);
        win.set_child(overlay);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, state) => this._key(keyval, state));
        win.add_controller(keys);
        win.connect('notify::is-active', () => {
            if (!win.is_active && this._down && !this._inside && !this._busy.size)
                this._evaluate(true);
        });

        // the menu on right-click
        const group = new Gio.SimpleActionGroup();
        for (const name of ['copy', 'markup', 'open', 'quicklook', 'show', 'save', 'letgo']) {
            const action = new Gio.SimpleAction({name});
            action.connect('activate', () => this._menuItem && this.act(name, this._menuItem));
            group.add_action(action);
        }
        win.insert_action_group('card', group);

        win.connect('realize', () => {
            win.get_surface().connect('layout', () => {
                this._region = null;
                this._syncRegion();
            });
            this._syncRegion();
        });
        win.connect('close-request', () => true);   // only the shell side puts it away
        win.present();
    }

    /** Only the visible band of the line catches the pointer; elsewhere clicks go to the windows below. */
    _syncRegion() {
        const surface = this.window.get_surface();
        if (!surface)
            return;
        const W = this.window.get_width() || 4000;
        let bottom = 0;
        // the whole band while it is down or moving: changing the region on every frame of the
        // drop would cost a round trip to the compositor each time
        if (!this.view.isHidden)
            bottom = Math.max(0, Math.round(this.view.bandBottom));
        if (this._searchBox.visible)
            bottom = Math.max(bottom, 56);
        const key = `${W}x${bottom}`;
        if (key === this._region)
            return;
        this._region = key;
        const region = new Cairo.Region();
        if (bottom > 0)
            region.unionRectangle({x: 0, y: 0, width: W, height: bottom});
        surface.set_input_region(region);
    }

    // ------------------------------------------------------------- coming down, going up

    _emit() {
        const json = this.GetState();
        try {
            this._dbus.emit_signal('StateChanged', new GLib.Variant('(s)', [json]));
        } catch (_e) {
            // nobody listening yet
        }
    }

    _event(name) {
        try {
            this._dbus.emit_signal('Event', new GLib.Variant('(s)', [name]));
        } catch (_e) {
            // nobody listening
        }
    }

    _setBusy(what, on) {
        if (on)
            this._busy.add(what);
        else
            this._busy.delete(what);
        this._evaluate();
    }

    _cancelTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    /** Decide whether the line should go back up soon. */
    _evaluate(now = false) {
        this._cancelTimer();
        if (!this._down || this._busy.size || this._inside || this._panel)
            return;
        if (this._reason === 'peek') {
            this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_FOR, () => {
                this._timer = 0;
                this.Tuck();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        // brought down by the shortcut or search: stays until you have been on it and left
        if ((this._reason === 'shortcut' || this._reason === 'search') && !this._touched && !now)
            return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, now ? 120 : TUCK_AFTER, () => {
            this._timer = 0;
            if (!this._inside && !this._panel && !this._busy.size)
                this.Tuck();
            return GLib.SOURCE_REMOVE;
        });
    }

    _bringDown(reason) {
        const wasDown = this._down;
        if (wasDown && reason === 'peek')
            return;     // already showing: just let the new item drop in
        this._down = true;
        if (!wasDown || reason !== 'hover')
            this._reason = reason;
        if (!wasDown)
            this._touched = this._inside;
        this.view.setDown(true);
        this._region = null;
        this._syncRegion();
        this._evaluate();
        this._emit();
    }

    // ------------------------------------------------------------- D-Bus

    Reveal(reason) {
        this._bringDown(reason || 'shortcut');
    }

    Tuck() {
        const wasDown = this._down;
        this._down = false;
        if (this._searchBox.visible)
            this._endSearch();
        this._cancelTimer();
        if (!wasDown)
            return;
        this._reason = '';
        this.view.setDown(false);
        this._emit();
    }

    Toggle() {
        if (this._down)
            this.Tuck();
        else
            this._bringDown('shortcut');
    }

    Search() {
        this._bringDown('search');
        this._searchBox.visible = true;
        this._setBusy('search', true);
        this._region = null;
        this._syncRegion();
        // the shell gives the window keyboard focus (see Keeper.search)
        this._search.grab_focus();
        this._filter();
        this._emit();
    }

    PanelHover(inside) {
        this._panel = inside;
        this._evaluate();
    }

    HangText(text) {
        const s = this._settings;
        const item = this.store.addText(text, {notes: s.get_boolean('hang-text'), links: s.get_boolean('hang-links')});
        return item?.id ?? '';
    }

    HangFile(path, how) {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return '';
        path = file.get_path();
        if (how === 'clipboard-image') {
            const owned = this._adopt(path, 'Copied image');
            const item = this.store.add({kind: 'image', path: owned, owned: true, via: 'clipboard', title: 'Copied image'});
            this._read(item);
            return item.id;
        }
        if (isImage(path)) {
            const item = this.store.add({kind: how === 'screenshot' ? 'screenshot' : 'image', path, owned: false,
                via: how === 'screenshot' ? 'folder' : 'file', title: GLib.path_get_basename(path)});
            this._read(item);
            return item.id;
        }
        if (isVideo(path))
            return this.store.add({kind: 'recording', path, owned: false, via: 'file', title: GLib.path_get_basename(path)}).id;
        try {
            const [, bytes] = GLib.file_get_contents(path);
            const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/\n+$/, '');
            return this.HangText(text);
        } catch (_e) {
            return '';
        }
    }

    Copy(which) {
        const item = this.store.find(which);
        if (!item)
            return false;
        this.act('copy', item);
        return true;
    }

    LetGo(which) {
        const item = this.store.find(which);
        if (!item)
            return false;
        this.store.letGo(item.id);
        return true;
    }

    PutBack() {
        return this.store.putBack().length > 0;
    }

    Clear() {
        this.store.clear();
    }

    GetState() {
        const folders = captureFolders();
        return JSON.stringify({
            running: true,
            version: this.version,
            down: this._down,
            reason: this._reason,
            searching: this._searchBox.visible,
            count: this.store.items.length,
            canPutBack: this.store.gone.length > 0,
            readsText: this._reader.available,
            store: this.store.dir,
            screenshots: folders.screenshots,
            recordings: folders.recordings,
        });
    }

    GetItems() {
        return JSON.stringify(this.store.items.map(i => ({
            id: i.id, kind: i.kind, title: i.title ?? '', path: i.path ?? '', url: i.url ?? '',
            created: i.created, text: i.kind === 'note' ? i.text.slice(0, 2000) : '',
        })));
    }

    /** Where each item is drawn, in the window's coordinates (for scripts and the tests). */
    GetLayout() {
        return JSON.stringify(this.store.items.map(i => ({id: i.id, kind: i.kind, rect: this.view.cardRect(i)}))
            .filter(e => e.rect));
    }

    Quit() {
        this.destroy();
        this._app.quit();
    }

    // ------------------------------------------------------------- arriving items

    /** Move a file into Festoon's own folder. */
    _adopt(path, stem) {
        const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1] ?? 'png';
        const dest = this.store.newPath(stem, ext.toLowerCase());
        try {
            Gio.File.new_for_path(path).move(Gio.File.new_for_path(dest), Gio.FileCopyFlags.NONE, null, null);
            return dest;
        } catch (e) {
            console.warn(`Festoon: could not move ${path}: ${e.message}`);
            return path;
        }
    }

    _fileArrived(path, kind) {
        let owned = false;
        if (kind === 'screenshot' && this._settings.get_boolean('tidy-screenshots')) {
            const moved = this._adopt(path, GLib.path_get_basename(path).replace(/\.[^.]+$/, ''));
            owned = moved !== path;
            path = moved;
        }
        const item = this.store.add({kind, path, owned, via: 'folder', title: GLib.path_get_basename(path)});
        this._read(item);
        if (this._settings.get_boolean('peek'))
            this._bringDown('peek');
    }

    _read(item) {
        if (!item || item.ocr || !['screenshot', 'image'].includes(item.kind) || !this._settings.get_boolean('read-text'))
            return;
        const id = item.id;
        this._reader.read(item.path, text => {
            if (this.store.get(id))
                this.store.update(id, {ocr: text});
        });
    }

    _storeChanged(what, item) {
        const fresh = what === 'added' && item ? item.id : null;
        this.view.setItems(this.store.items, fresh);
        if (what === 'added')
            this._event('hung');
        if (this._searchBox.visible)
            this._filter();
        this._region = null;
        this._syncRegion();
        this._emit();
    }

    // ------------------------------------------------------------- search

    _filter() {
        const words = this._search.text.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) {
            this.view.setFilter(null);
            this._count.label = '';
            this.view.message = '';
            return;
        }
        const ids = new Set(this.store.items.filter(i => {
            const hay = Store.haystack(i);
            return words.every(w => hay.includes(w));
        }).map(i => i.id));
        this.view.setFilter(ids);
        this._count.label = ids.size ? `${ids.size}` : 'None';
    }

    _copyFirstMatch() {
        const words = this._search.text.toLowerCase().split(/\s+/).filter(Boolean);
        const item = this.store.items.find(i => words.every(w => Store.haystack(i).includes(w)));
        if (!item)
            return;
        this.act('copy', item);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 650, () => {
            this.Tuck();
            return GLib.SOURCE_REMOVE;
        });
    }

    _endSearch() {
        this._searchBox.visible = false;
        this._search.text = '';
        this.view.setFilter(null);
        this._setBusy('search', false);
        this._region = null;
        this._syncRegion();
    }

    _key(keyval, state) {
        const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const hovered = this.view.hovered?.item ?? null;
        if (keyval === Gdk.KEY_Escape) {
            this.Tuck();
            return true;
        }
        if (ctrl && keyval === Gdk.KEY_f) {
            this.Search();
            return true;
        }
        if (ctrl && keyval === Gdk.KEY_z) {
            this.PutBack();
            return true;
        }
        if (this._search.has_focus && this._searchBox.visible)
            return false;
        if (!hovered)
            return false;
        if (keyval === Gdk.KEY_space) {
            this.act('quicklook', hovered);
            return true;
        }
        if (keyval === Gdk.KEY_Delete || keyval === Gdk.KEY_BackSpace) {
            this.act('letgo', hovered);
            return true;
        }
        if (ctrl && keyval === Gdk.KEY_c) {
            this.act('copy', hovered);
            return true;
        }
        if (keyval === Gdk.KEY_Return) {
            this.act('open', hovered);
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------- gestures

    act(action, item, extra = null) {
        switch (action) {
        case 'copy': this._copy(item); break;
        case 'open': this._open(item); break;
        case 'markup': this._markup(item); break;
        case 'quicklook': this._quickLook(item); break;
        case 'letgo': this.store.letGo(item.id); break;
        case 'show': this._showInFiles(item); break;
        case 'save': this._saveAs(item); break;
        case 'menu': this._menu(item, extra); break;
        }
    }

    _setClipboard(mime, value, isPath) {
        if (this._shell) {
            this._shell.call('SetClipboard', new GLib.Variant('(ssb)', [mime, value, isPath]),
                Gio.DBusCallFlags.NONE, 2000, null, (p, res) => {
                    try {
                        p.call_finish(res);
                    } catch (_e) {
                        this._setClipboardHere(mime, value, isPath);
                    }
                });
        } else {
            this._setClipboardHere(mime, value, isPath);
        }
    }

    /** Without GNOME Shell (while developing): GTK's own clipboard, which needs the window focused. */
    _setClipboardHere(mime, value, isPath) {
        const clipboard = this.window.get_clipboard();
        if (mime.startsWith('text/plain'))
            clipboard.set(value);
        else if (isPath)
            clipboard.set_content(Gdk.ContentProvider.new_for_bytes(mime, GLib.file_get_contents(value)[1]));
        else
            clipboard.set_content(Gdk.ContentProvider.new_for_bytes(mime, bytesOf(value)));
    }

    /** A PNG of an image item (converted once if it is another format). */
    _png(item) {
        if (/\.png$/i.test(item.path))
            return item.path;
        const cache = GLib.build_filenamev([GLib.get_user_cache_dir(), 'festoon', 'png']);
        GLib.mkdir_with_parents(cache, 0o700);
        const out = GLib.build_filenamev([cache, `${item.id}.png`]);
        if (!GLib.file_test(out, GLib.FileTest.EXISTS))
            GdkPixbuf.Pixbuf.new_from_file(item.path).savev(out, 'png', [], []);
        return out;
    }

    _copy(item) {
        try {
            switch (item.kind) {
            case 'screenshot':
            case 'image':
                this._setClipboard('image/png', this._png(item), true);
                break;
            case 'recording':
                this._setClipboard('text/uri-list', `${Gio.File.new_for_path(item.path).get_uri()}\r\n`, false);
                break;
            case 'note':
                this._setClipboard('text/plain;charset=utf-8', item.text, false);
                break;
            case 'link':
                this._setClipboard('text/plain;charset=utf-8', item.url, false);
                break;
            }
        } catch (e) {
            console.warn(`Festoon: could not copy: ${e.message}`);
            return;
        }
        this.view.flash(item);
        this._event('copied');
    }

    _launchContext() {
        return Gdk.Display.get_default().get_app_launch_context();
    }

    _uri(item) {
        if (item.kind === 'link')
            return item.url;
        return Gio.File.new_for_path(item.path).get_uri();
    }

    _open(item) {
        try {
            Gio.AppInfo.launch_default_for_uri(this._uri(item), this._launchContext());
        } catch (e) {
            console.warn(`Festoon: could not open ${this._uri(item)}: ${e.message}`);
        }
        this.Tuck();
    }

    _showInFiles(item) {
        if (!item.path)
            return;
        const uri = Gio.File.new_for_path(item.path).get_uri();
        Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[uri], '']),
            null, Gio.DBusCallFlags.NONE, 3000, null, (bus, res) => {
                try {
                    bus.call_finish(res);
                } catch (_e) {
                    const dir = Gio.File.new_for_path(item.path).get_parent().get_uri();
                    Gio.AppInfo.launch_default_for_uri(dir, this._launchContext());
                }
            });
        this.Tuck();
    }

    _saveAs(item) {
        const dialog = new Gtk.FileDialog({title: 'Save a copy'});
        const name = item.kind === 'note' ? `${item.title || 'Note'}.txt`
            : item.kind === 'link' ? `${item.title || 'Link'}.txt` : GLib.path_get_basename(item.path);
        dialog.set_initial_name(name.replace(/[/\\]/g, ' '));
        this._setBusy('dialog', true);
        dialog.save(null, null, (_d, res) => {
            this._setBusy('dialog', false);
            let file;
            try {
                file = dialog.save_finish(res);
            } catch (_e) {
                return;     // cancelled
            }
            try {
                if (item.kind === 'note' || item.kind === 'link')
                    file.replace_contents(bytesOf(item.kind === 'note' ? item.text : item.url), null, false, Gio.FileCreateFlags.NONE, null);
                else
                    Gio.File.new_for_path(item.path).copy(file, Gio.FileCopyFlags.OVERWRITE, null, null);
            } catch (e) {
                console.warn(`Festoon: could not save: ${e.message}`);
            }
        });
        this.Tuck();
    }

    _single(key, make) {
        const open = this._editors.get(key);
        if (open) {
            open.present();
            return;
        }
        const win = make();
        if (!win)
            return;
        this._editors.set(key, win);
        win.connect('close-request', () => {
            this._editors.delete(key);
            return false;
        });
        // go up once the new window has the keyboard, so the shell doesn't hand it elsewhere
        const id = win.connect('map', () => {
            win.disconnect(id);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this.Tuck();
                return GLib.SOURCE_REMOVE;
            });
        });
        win.present();
    }

    _markup(item) {
        if (item.kind === 'note') {
            this._single(`note:${item.id}`, () => new NoteWindow(this._app, item, text => {
                this.store.setNoteText(item.id, text);
                const now = this.store.get(item.id);
                if (now)
                    this._copy(now);
            }));
            return;
        }
        if (item.kind === 'screenshot' || item.kind === 'image') {
            this._single(`markup:${item.id}`, () => new MarkupWindow(this._app, item, pixbufSaver => {
                // A marked-up copy is Festoon's own file; the original stays where it was.
                const dest = item.owned ? item.path.replace(/\.[^.]+$/, '.png') : this.store.newPath(`${item.title?.replace(/\.[^.]+$/, '') || 'Screenshot'} (marked up)`, 'png');
                this._folders.ignore(dest);
                pixbufSaver(dest);
                if (item.owned && dest !== item.path) {
                    try {
                        Gio.File.new_for_path(item.path).delete(null);
                    } catch (_e) {
                        // fine
                    }
                }
                const updated = this.store.update(item.id, {path: dest, owned: true, hash: null, ocr: item.ocr});
                if (updated) {
                    this.view.setItems(this.store.items);
                    this._copy(updated);
                }
            }));
            return;
        }
        this._open(item);
    }

    _quickLook(item) {
        this._single(`look:${item.id}`, () => new QuickLook(this._app, item, {
            copy: () => this._copy(item),
            open: () => this._open(item),
        }));
    }

    _menu(item, where) {
        this._menuItem = item;
        const menu = new Gio.Menu();
        const first = new Gio.Menu();
        first.append('Copy', 'card.copy');
        if (item.kind === 'note')
            first.append('Edit…', 'card.markup');
        else if (item.kind === 'screenshot' || item.kind === 'image')
            first.append('Markup…', 'card.markup');
        first.append('Quick Look', 'card.quicklook');
        first.append(item.kind === 'link' ? 'Open in Browser' : 'Open', 'card.open');
        menu.append_section(null, first);
        const second = new Gio.Menu();
        if (item.path && item.kind !== 'note')
            second.append('Show in Files', 'card.show');
        second.append('Save a Copy…', 'card.save');
        menu.append_section(null, second);
        const third = new Gio.Menu();
        third.append('Let Go', 'card.letgo');
        menu.append_section(null, third);

        const popover = Gtk.PopoverMenu.new_from_model(menu);
        popover.set_parent(this.view);
        popover.set_has_arrow(true);
        if (where) {
            const r = new Gdk.Rectangle({x: Math.round(where.x), y: Math.round(where.y), width: Math.round(where.width), height: Math.round(where.height)});
            popover.set_pointing_to(r);
        }
        popover.set_position(Gtk.PositionType.BOTTOM);
        this._setBusy('menu', true);
        popover.connect('closed', () => {
            this._setBusy('menu', false);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                popover.unparent();
                return GLib.SOURCE_REMOVE;
            });
            if (!this._inside)
                this._evaluate(true);
        });
        popover.popup();
    }

    /** What an item becomes when dragged into another app or a folder. */
    _content(item) {
        const providers = [];
        try {
            if (item.path && item.kind !== 'note') {
                const uri = Gio.File.new_for_path(item.path).get_uri();
                providers.push(Gdk.ContentProvider.new_for_bytes('text/uri-list', bytesOf(`${uri}\r\n`)));
                if (item.kind === 'screenshot' || item.kind === 'image') {
                    const [, data] = GLib.file_get_contents(this._png(item));
                    providers.push(Gdk.ContentProvider.new_for_bytes('image/png', new GLib.Bytes(data)));
                }
                providers.push(Gdk.ContentProvider.new_for_bytes('x-special/gnome-copied-files', bytesOf(`copy\n${uri}`)));
            } else if (item.kind === 'note') {
                providers.push(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytesOf(item.text)));
            } else if (item.kind === 'link') {
                providers.push(Gdk.ContentProvider.new_for_bytes('text/uri-list', bytesOf(`${item.url}\r\n`)));
                providers.push(Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytesOf(item.url)));
            }
        } catch (e) {
            console.warn(`Festoon: cannot drag ${item.id}: ${e.message}`);
        }
        if (!providers.length)
            return null;
        return providers.length === 1 ? providers[0] : Gdk.ContentProvider.new_union(providers);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._cancelTimer();
        if (this._pruneId)
            GLib.source_remove(this._pruneId);
        this._pruneId = 0;
        for (const id of this._settingIds)
            this._settings.disconnect(id);
        this._settingIds = [];
        this._folders.destroy();
        this._reader.destroy();
        this.store.destroy();
        this.view.destroy();
        try {
            this._dbus.unexport();
        } catch (_e) {
            // already gone
        }
    }
}
