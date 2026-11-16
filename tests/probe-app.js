#!/usr/bin/env -S gjs -m
// A plain GTK 4 window for the end-to-end tests. It logs every click it receives (to prove the
// line lets clicks through while it is up), every drop (to prove items can be dragged into an
// app), and copies to the clipboard on request, like any app would.
//
//   gjs -m tests/probe-app.js /tmp/probe.log /tmp/probe.cmd
//
// Commands, one per line in the command file: copy-text <text>, copy-secret <text>,
// copy-image <path>, copy-files <path>...

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

const [logPath, cmdPath] = ARGV;
const log = line => {
    const s = Gio.File.new_for_path(logPath).append_to(Gio.FileCreateFlags.NONE, null);
    s.write_all(`${line}\n`, null);
    s.close(null);
};
const bytes = s => new GLib.Bytes(new TextEncoder().encode(s));

const app = new Gtk.Application({application_id: 'io.github.festoon.Probe'});
app.connect('activate', () => {
    const win = new Gtk.ApplicationWindow({application: app, title: 'Probe', default_width: 1280, default_height: 768});
    const css = new Gtk.CssProvider();
    css.load_from_data('window { background: #f4ede0; } label { font-size: 26px; color: #1b1a17; }', -1);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, 600);
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 140, margin_start: 60});
    for (let i = 1; i <= 6; i++)
        box.append(new Gtk.Label({label: `Paragraph ${i}: something worth copying`, xalign: 0}));
    win.set_child(new Gtk.ScrolledWindow({child: box}));

    const click = new Gtk.GestureClick({button: 0});
    click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    click.connect('pressed', (_g, _n, x, y) => log(`press ${click.get_current_button()} ${Math.round(x)},${Math.round(y)}`));
    win.add_controller(click);

    const drop = new Gtk.DropTarget({actions: Gdk.DragAction.COPY});
    drop.set_gtypes([Gdk.FileList.$gtype, GObject.TYPE_STRING]);
    drop.connect('drop', (_t, value, x, y) => {
        if (value instanceof Gdk.FileList)
            log(`drop files ${value.get_files().map(f => f.get_path()).join(' ')} at ${Math.round(x)},${Math.round(y)}`);
        else
            log(`drop text ${String(value).replace(/\n/g, '\\n')}`);
        return true;
    });
    win.add_controller(drop);

    const clipboard = win.get_clipboard();
    let done = 0;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        let text = '';
        try {
            text = new TextDecoder().decode(GLib.file_get_contents(cmdPath)[1]);
        } catch (_e) {
            return GLib.SOURCE_CONTINUE;
        }
        const lines = text.split('\n').filter(Boolean);
        for (const line of lines.slice(done)) {
            const [cmd, ...rest] = line.split(' ');
            const arg = rest.join(' ').replace(/\\n/g, '\n');
            if (cmd === 'copy-text') {
                clipboard.set(arg);
            } else if (cmd === 'copy-secret') {
                clipboard.set_content(Gdk.ContentProvider.new_union([
                    Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes(arg)),
                    Gdk.ContentProvider.new_for_bytes('x-kde-passwordManagerHint', bytes('secret')),
                ]));
            } else if (cmd === 'copy-image') {
                clipboard.set_content(Gdk.ContentProvider.new_for_bytes('image/png', GLib.file_get_contents(arg)[1]));
            } else if (cmd === 'copy-files') {
                const uris = rest.map(p => Gio.File.new_for_path(p).get_uri());
                clipboard.set_content(Gdk.ContentProvider.new_union([
                    Gdk.ContentProvider.new_for_bytes('text/uri-list', bytes(uris.map(u => `${u}\r\n`).join(''))),
                    Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes(rest.join('\n'))),
                ]));
            }
            log(`did ${cmd}`);
        }
        done = lines.length;
        return GLib.SOURCE_CONTINUE;
    });

    win.maximize();
    win.present();
    log('ready');
});
app.run([]);
