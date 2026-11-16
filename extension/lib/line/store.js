// What hangs on the line, kept on disk so it survives logging out.
//
// Everything lives in ~/.local/share/festoon: `items.json` and an `items/` folder with the
// files Festoon owns (copied images, notes, screenshots moved off the Screenshots folder).
// Screenshots that stay in ~/Pictures/Screenshots are only referenced, never deleted.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {dataDir} from '../settings.js';

const GONE_BATCHES = 20;
const MAX_TEXT = 256 * 1024;

export const KINDS = ['screenshot', 'image', 'recording', 'note', 'link'];

const URL_RE = /^(https?:\/\/|www\.)[^\s<>"]+$/i;

/** A single web address, or null. */
export function asLink(text) {
    const t = text.trim();
    if (!URL_RE.test(t) || t.length > 4096)
        return null;
    const url = /^www\./i.test(t) ? `https://${t}` : t;
    try {
        const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        if (!uri.get_host())
            return null;
        return url;
    } catch (_e) {
        return null;
    }
}

/** "github.com" and "/dabane-ghassan/manicule" from a web address. */
export function linkParts(url) {
    try {
        const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        const site = (uri.get_host() ?? '').replace(/^www\./, '');
        let path = GLib.Uri.unescape_string(uri.get_path() ?? '', null) ?? uri.get_path() ?? '';
        if (path === '/')
            path = '';
        const query = uri.get_query();
        if (query)
            path += `?${query}`;
        return {site, path};
    } catch (_e) {
        return {site: url, path: ''};
    }
}

export function firstLine(text) {
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (t)
            return t.length > 80 ? `${t.slice(0, 79)}…` : t;
    }
    return '';
}

function exists(path) {
    return !!path && GLib.file_test(path, GLib.FileTest.EXISTS);
}

function remove(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch (_e) {
        // already gone
    }
}

function checksum(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA1, bytes);
    } catch (_e) {
        return null;
    }
}

function safeName(text) {
    const s = text.replace(/[/\\:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    return s || 'Note';
}

export class Store {
    constructor(dir = dataDir()) {
        this.dir = dir;
        this.files = GLib.build_filenamev([dir, 'items']);
        this._index = GLib.build_filenamev([dir, 'items.json']);
        GLib.mkdir_with_parents(this.files, 0o700);
        this.items = [];        // newest first
        this.gone = [];         // batches of let-go items, newest first: [{at, items}]
        this.max = 30;
        this.onChanged = null;  // (what, item) => void
        this._saveId = 0;
        this._load();
    }

    _load() {
        try {
            const [, bytes] = GLib.file_get_contents(this._index);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            this.items = (data.items ?? []).filter(i => KINDS.includes(i.kind));
            this.gone = data.gone ?? [];
        } catch (_e) {
            this.items = [];
            this.gone = [];
        }
        this.prune();
    }

    save(now = false) {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = 0;
        const write = () => {
            this._saveId = 0;
            const json = JSON.stringify({version: 1, items: this.items, gone: this.gone}, null, 1);
            try {
                GLib.file_set_contents(this._index, json);
            } catch (e) {
                console.warn(`Festoon: could not save ${this._index}: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        };
        if (now)
            write();
        else
            this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, 300, write);
    }

    _changed(what, item = null) {
        this.save();
        this.onChanged?.(what, item);
    }

    get(id) {
        return this.items.find(i => i.id === id) ?? null;
    }

    /** "newest", "1" (the first on the line), or an id. */
    find(which) {
        if (!which || which === 'newest' || which === 'first')
            return this.items[0] ?? null;
        if (/^\d+$/.test(which))
            return this.items[Number(which) - 1] ?? null;
        return this.get(which);
    }

    /** A path for a new file Festoon owns. */
    newPath(stem, ext) {
        const base = safeName(stem);
        for (let n = 0; ; n++) {
            const name = n ? `${base} ${n + 1}.${ext}` : `${base}.${ext}`;
            const path = GLib.build_filenamev([this.files, name]);
            if (!exists(path))
                return path;
        }
    }

    _newId() {
        return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    }

    /**
     * Hang something. `fields` is {kind, path?, owned?, text?, url?, title?, via?}.
     * Returns the item now on the line (an existing one if this was a repeat).
     */
    add(fields) {
        const item = {
            id: this._newId(),
            created: Date.now(),
            owned: false,
            via: 'folder',
            ...fields,
        };
        if (item.path && !item.hash && item.kind !== 'recording')
            item.hash = checksum(item.path);

        // the same thing again: move it to the front instead of hanging it twice
        const same = this.items.find(i => i.kind === item.kind &&
            ((item.hash && i.hash === item.hash) || (item.text && i.text === item.text) ||
             (item.url && i.url === item.url) || (item.path && i.path === item.path && !item.hash)));
        if (same) {
            if (item.owned && item.path !== same.path)
                remove(item.path);
            this.items = [same, ...this.items.filter(i => i !== same)];
            same.created = Date.now();
            this._changed('moved', same);
            return same;
        }
        // a screenshot that was already hung from the clipboard: keep one, pointing at the file
        if (item.kind === 'screenshot' && item.hash) {
            const twin = this.items.find(i => i.kind === 'image' && i.hash === item.hash && i.via === 'clipboard');
            if (twin) {
                if (twin.owned)
                    remove(twin.path);
                Object.assign(twin, {kind: 'screenshot', path: item.path, owned: item.owned, via: item.via, title: item.title});
                this._changed('updated', twin);
                return twin;
            }
        }

        this.items.unshift(item);
        this._changed('added', item);
        this.trim();
        return item;
    }

    addText(text, {notes = true, links = true} = {}) {
        if (!text || !text.trim())
            return null;
        if (text.length > MAX_TEXT)
            text = text.slice(0, MAX_TEXT);
        const url = asLink(text);
        if (url) {
            if (!links)
                return null;
            const {site} = linkParts(url);
            return this.add({kind: 'link', url, title: site, via: 'clipboard'});
        }
        if (!notes)
            return null;
        const title = firstLine(text);
        const existing = this.items.find(i => i.kind === 'note' && i.text === text);
        if (existing)
            return this.add({kind: 'note', text, title});
        const path = this.newPath(title, 'txt');
        try {
            GLib.file_set_contents(path, text);
        } catch (_e) {
            return null;
        }
        return this.add({kind: 'note', text, title, path, owned: true, via: 'clipboard'});
    }

    update(id, patch) {
        const item = this.get(id);
        if (!item)
            return null;
        Object.assign(item, patch);
        this._changed('updated', item);
        return item;
    }

    setNoteText(id, text) {
        const item = this.get(id);
        if (!item || item.kind !== 'note')
            return null;
        if (item.path) {
            try {
                GLib.file_set_contents(item.path, text);
            } catch (_e) {
                // the item still changes
            }
        }
        return this.update(id, {text, title: firstLine(text)});
    }

    /** Let one item go. It can be put back. */
    letGo(id) {
        const item = this.get(id);
        if (!item)
            return null;
        this.items = this.items.filter(i => i !== item);
        this._pushGone([item]);
        this._changed('removed', item);
        return item;
    }

    /** Take everything down at once. Put back brings it all back. */
    clear() {
        if (!this.items.length)
            return [];
        const all = this.items;
        this.items = [];
        this._pushGone(all);
        this._changed('cleared');
        return all;
    }

    /** Bring back what was let go last. */
    putBack() {
        while (this.gone.length) {
            const batch = this.gone.shift();
            const back = batch.items.filter(i => !i.path || exists(i.path) || i.kind === 'link');
            if (!back.length)
                continue;
            const ids = new Set(this.items.map(i => i.id));
            this.items = [...back.filter(i => !ids.has(i.id)), ...this.items];
            this._changed('restored', back[0]);
            this.trim(false);
            return back;
        }
        return [];
    }

    _pushGone(items) {
        this.gone.unshift({at: Date.now(), items});
        while (this.gone.length > GONE_BATCHES)
            this._forget(this.gone.pop().items);
    }

    /** Delete Festoon's own copies of items that can no longer come back. */
    _forget(items) {
        const live = new Set(this.items.map(i => i.path));
        for (const i of items) {
            if (i.owned && i.path && !live.has(i.path))
                remove(i.path);
        }
    }

    /** Keep at most `max` items; the oldest fall off (and can be put back). */
    trim(notify = true) {
        if (this.items.length <= this.max)
            return;
        const extra = this.items.slice(this.max);
        this.items = this.items.slice(0, this.max);
        this._pushGone(extra);
        if (notify)
            this._changed('trimmed');
    }

    /** Drop items whose file was deleted behind our back. */
    prune() {
        const before = this.items.length;
        this.items = this.items.filter(i => i.kind === 'link' || (i.kind === 'note' && i.text) || exists(i.path));
        if (this.items.length !== before)
            this._changed('pruned');
    }

    /** Text that search looks at. */
    static haystack(item) {
        return [item.title, item.text, item.url, item.ocr, item.path ? GLib.path_get_basename(item.path) : '']
            .filter(Boolean).join('\n').toLowerCase();
    }

    destroy() {
        if (this._saveId)
            this.save(true);
    }
}
