// Settings for the processes that run outside GNOME Shell (the line and the app).
// They read the schema straight from the extension folder, as GNOME Shell does.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gettext from 'gettext';

import {SCHEMA} from './common.js';

export function loadSettings(extensionDir) {
    const dir = GLib.build_filenamev([extensionDir, 'schemas']);
    if (!GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS)) {
        try {
            GLib.spawn_command_line_sync(`glib-compile-schemas ${GLib.shell_quote(dir)}`);
        } catch (_e) {
            // a read-only install without compiled schemas: lookup below falls back to the system
        }
    }
    let source = Gio.SettingsSchemaSource.get_default();
    try {
        source = Gio.SettingsSchemaSource.new_from_directory(dir, source, false);
    } catch (_e) {
        // installed system-wide instead
    }
    const schema = source.lookup(SCHEMA, true);
    if (!schema)
        throw new Error(`settings schema ${SCHEMA} not found in ${dir}`);
    return new Gio.Settings({settings_schema: schema});
}

export function readVersion(extensionDir) {
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([extensionDir, 'metadata.json']));
        return JSON.parse(new TextDecoder().decode(bytes))['version-name'];
    } catch (_e) {
        return null;
    }
}

/** Where Festoon keeps what hangs on the line. */
export function dataDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'festoon']);
}

/** The folders GNOME Shell saves screenshots and screen recordings to, in the user's language. */
export function captureFolders() {
    let shot = 'Screenshots';
    let cast = 'Screencasts';
    try {
        // GNOME Shell's own translations
        shot = Gettext.dgettext('gnome-shell', 'Screenshots');
        cast = Gettext.dgettext('gnome-shell', 'Screencasts');
    } catch (_e) {
        // English names
    }
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir();
    const videos = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) || GLib.get_home_dir();
    return {
        screenshots: GLib.build_filenamev([pictures, shot]),
        recordings: GLib.build_filenamev([videos, cast]),
    };
}
