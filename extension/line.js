#!/usr/bin/env -S gjs -m
// The line: a small GTK process that GNOME Shell starts at login and keeps on top of every
// window, invisible and click-through until it comes down. It is its own process because on
// Wayland only a real app window can drag files into other apps.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const {LINE_ID} = await import(`file://${here}/lib/common.js`);
const {loadSettings} = await import(`file://${here}/lib/settings.js`);
const {Line} = await import(`file://${here}/lib/line/line.js`);

GLib.set_prgname('festoon-line');
GLib.set_application_name('Festoon');

const app = new Adw.Application({
    application_id: LINE_ID,
    // a fresh line replaces one left over from before (after the shell restarted, say)
    flags: Gio.ApplicationFlags.ALLOW_REPLACEMENT | Gio.ApplicationFlags.REPLACE,
});
let line = null;
app.connect('startup', () => {
    Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(GLib.build_filenamev([here, 'assets', 'icons']));
    app.hold();
});
app.connect('activate', () => {
    if (line)
        return;
    try {
        line = new Line(app, here, loadSettings(here));
    } catch (e) {
        logError(e, 'Festoon: the line could not start');
        app.quit();
    }
});
app.connect('name-lost', () => {
    // replaced by a newer line
    line?.destroy();
    line = null;
    app.quit();
    return true;
});
app.connect('shutdown', () => line?.destroy());
System.exit(app.run([System.programInvocationName, ...ARGV]));
