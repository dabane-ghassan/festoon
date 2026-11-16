// Watches the Screenshots and Screencasts folders (and any the user adds) for new files.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {captureFolders} from '../settings.js';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic'];
const VIDEO_EXT = ['webm', 'mp4', 'mkv', 'mov', 'gif'];

export function extensionOf(path) {
    const m = /\.([a-z0-9]+)$/i.exec(path);
    return m ? m[1].toLowerCase() : '';
}

export const isImage = path => IMAGE_EXT.includes(extensionOf(path));
export const isVideo = path => VIDEO_EXT.includes(extensionOf(path)) && extensionOf(path) !== 'gif';

export class Folders {
    /** onFile(path, role): role is 'screenshot', 'recording' or 'picture'. */
    constructor(settings, onFile) {
        this._settings = settings;
        this._onFile = onFile;
        this._monitors = [];
        this._pending = new Map();      // path -> timeout id
        this._ignore = new Set();       // files Festoon writes or moves itself
        this._seen = new Set();
        this._since = GLib.get_real_time() / 1000 - 2000;
        this._ids = ['hang-screenshots', 'hang-recordings', 'watch-folders']
            .map(k => settings.connect(`changed::${k}`, () => this.rewatch()));
        this.rewatch();
    }

    get folders() {
        return captureFolders();
    }

    /** Don't hang this file when it shows up (Festoon is writing it). */
    ignore(path) {
        this._ignore.add(path);
        GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 10, () => {
            this._ignore.delete(path);
            return GLib.SOURCE_REMOVE;
        });
    }

    rewatch() {
        for (const m of this._monitors)
            m.cancel();
        this._monitors = [];
        const {screenshots, recordings} = this.folders;
        const watch = (dir, role) => {
            const file = Gio.File.new_for_path(dir);
            try {
                file.make_directory_with_parents(null);
            } catch (_e) {
                // already there, or not ours to create
            }
            try {
                const monitor = file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
                monitor.set_rate_limit(200);
                monitor.connect('changed', (_m, f, other, event) => this._event(f, other, event, role));
                this._monitors.push(monitor);
            } catch (e) {
                console.warn(`Festoon: cannot watch ${dir}: ${e.message}`);
            }
        };
        if (this._settings.get_boolean('hang-screenshots'))
            watch(screenshots, 'screenshot');
        if (this._settings.get_boolean('hang-recordings'))
            watch(recordings, 'recording');
        for (const dir of this._settings.get_strv('watch-folders')) {
            if (dir && dir !== screenshots && dir !== recordings)
                watch(dir, 'picture');
        }
    }

    _event(file, other, event, role) {
        const E = Gio.FileMonitorEvent;
        let target = file;
        if (event === E.MOVED_IN || event === E.RENAMED)
            target = other ?? file;
        else if (![E.CREATED, E.CHANGED, E.CHANGES_DONE_HINT].includes(event))
            return;
        const path = target?.get_path();
        if (!path || this._ignore.has(path) || this._seen.has(path))
            return;
        const name = GLib.path_get_basename(path);
        if (name.startsWith('.') || name.endsWith('~') || name.endsWith('.part') || name.endsWith('.crdownload'))
            return;
        const video = isVideo(path);
        if (!video && !isImage(path))
            return;
        if (role === 'recording' && !video)
            return;
        // Recordings are written for as long as they last: wait until the file is closed.
        // Pictures are written in one go: wait for a short quiet spell.
        if (video && event !== E.CHANGES_DONE_HINT && event !== E.MOVED_IN && event !== E.RENAMED)
            return;
        const old = this._pending.get(path);
        if (old)
            GLib.source_remove(old);
        this._pending.set(path, GLib.timeout_add(GLib.PRIORITY_DEFAULT, video ? 100 : 250, () => {
            this._pending.delete(path);
            this._settle(path, video ? 'recording' : role === 'recording' ? 'recording' : role);
            return GLib.SOURCE_REMOVE;
        }));
    }

    _settle(path, role) {
        let info;
        try {
            info = Gio.File.new_for_path(path).query_info('standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        } catch (_e) {
            return;     // already moved or deleted
        }
        if (info.get_size() <= 0)
            return;
        const modified = info.get_modification_date_time()?.to_unix() * 1000;
        if (modified && modified < this._since)
            return;     // an old file renamed in place
        this._seen.add(path);
        if (this._seen.size > 500)
            this._seen = new Set([...this._seen].slice(-200));
        const kind = role === 'recording' ? 'recording' : role === 'screenshot' ? 'screenshot' : (isVideo(path) ? 'recording' : 'image');
        this._onFile(path, kind);
    }

    destroy() {
        for (const id of this._ids)
            this._settings.disconnect(id);
        for (const m of this._monitors)
            m.cancel();
        for (const id of this._pending.values())
            GLib.source_remove(id);
        this._pending.clear();
        this._monitors = [];
    }
}
