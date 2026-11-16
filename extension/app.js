#!/usr/bin/env -S gjs -m
// The Festoon app: the window you get from the app list.
// The line itself is kept up by GNOME Shell (extension.js, line.js); this window shows what is
// on it and holds every setting.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import 'gi://Gtk?version=4.0';
import System from 'system';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const {APP_ID} = await import(`file://${here}/lib/common.js`);
const {loadSettings, readVersion} = await import(`file://${here}/lib/settings.js`);
const {buildAppWindow} = await import(`file://${here}/lib/app/window.js`);

const app = new Adw.Application({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
app.connect('activate', () => {
    let window = app.get_active_window();
    if (!window)
        window = buildAppWindow(app, here, readVersion(here), loadSettings(here));
    window.present();
});
System.exit(app.run([System.programInvocationName, ...ARGV]));
