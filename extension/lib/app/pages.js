// The settings pages of the Festoon window. Used both by the app (app.js) and by GNOME's own
// extension settings dialog (prefs.js).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ROPES} from '../line/rope.js';
import {captureFolders, dataDir} from '../settings.js';

const SHORTCUTS = [
    ['show-shortcut', 'Bring the line down, or put it away'],
    ['search-shortcut', 'Search the line'],
];
const DELAYS = [[120, 'Right away'], [350, 'After a short rest'], [800, 'After a longer rest']];
const SIZES = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']];
const RESET_KEYS = [
    'hang-screenshots', 'hang-recordings', 'watch-folders', 'tidy-screenshots', 'quiet-screenshots', 'hang-images',
    'hang-text', 'hang-links', 'read-text', 'reveal-on-hover', 'reveal-edge-only', 'reveal-delay', 'peek', 'max-items', 'size', 'rope',
    'zoom-on-hover', 'sway', 'sounds', 'show-indicator', 'show-shortcut', 'search-shortcut',
];
export const GESTURES = [
    ['Click', 'Copy it'],
    ['Press and hold', 'Markup for pictures, edit a note'],
    ['Double-click', 'Open it'],
    ['Shift-click or Space', 'Quick Look'],
    ['Drag', 'Into any app or folder'],
    ['× or middle-click', 'Let it go (Ctrl+Z puts it back)'],
    ['Right-click', 'Everything else'],
];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboRow(title, options, get, set, subtitle = '') {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(options.map(o => o[1]))});
    const sync = () => {
        const value = get();
        let i = options.findIndex(o => o[0] === value);
        if (i < 0 && typeof value === 'number')     // nearest number
            i = options.reduce((best, o, j) => Math.abs(o[0] - value) < Math.abs(options[best][0] - value) ? j : best, 0);
        if (i >= 0 && row.selected !== i)
            row.selected = i;
    };
    sync();
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value !== undefined && value !== get())
            set(value);
    });
    return [row, sync];
}

export function accelLabel(accel) {
    if (!accel)
        return '';
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    return ok === false ? accel : Gtk.accelerator_get_label(key, mods);
}

export class Pages {
    constructor(path, version) {
        this.path = path;
        this.version = version ?? '1.0.0';
    }

    /** Fill GNOME's stock preferences window (used by prefs.js). */
    fill(window, settings) {
        window.set_default_size(680, 760);
        const host = {window, toast: t => window.add_toast(t)};
        for (const page of this.build(host, settings))
            window.add(page);
    }

    /** Every settings page, in order: Hanging, The line, Controls, About. */
    build(host, settings) {
        return [
            this._hangingPage(host, settings),
            this._linePage(host, settings),
            this._controlsPage(host, settings),
            this._aboutPage(host, settings),
        ];
    }

    // ------------------------------------------------------------ what hangs

    _hangingPage(host, settings) {
        const page = new Adw.PreferencesPage({title: 'Hanging', icon_name: 'insert-image-symbolic'});
        const folders = captureFolders();
        const home = GLib.get_home_dir();
        const nice = p => p.startsWith(home) ? `~${p.slice(home.length)}` : p;

        const captures = new Adw.PreferencesGroup({
            title: 'Screenshots and recordings',
            description: 'Everything you capture with GNOME’s screenshot tool, or any app that saves to these folders.',
        });
        captures.add(switchRow(settings, 'hang-screenshots', 'Screenshots', nice(folders.screenshots)));
        captures.add(switchRow(settings, 'hang-recordings', 'Screen recordings', nice(folders.recordings)));
        captures.add(switchRow(settings, 'tidy-screenshots', 'Keep screenshots only on the line',
            'New screenshots move out of the Screenshots folder. Letting one go deletes it, after it can no longer be put back.'));
        captures.add(switchRow(settings, 'quiet-screenshots', 'Skip the “Screenshot captured” notification',
            'The screenshot is already on the line.'));
        const ocr = !!GLib.find_program_in_path('tesseract');
        captures.add(switchRow(settings, 'read-text', 'Read the text in screenshots',
            ocr ? 'So search can find them. It all happens on this computer.'
                : 'So search can find them. Needs tesseract, which is not installed (sudo apt/dnf install tesseract).'));
        page.add(captures);

        const copied = new Adw.PreferencesGroup({
            title: 'What you copy',
            description: 'Nothing is kept from password managers.',
        });
        copied.add(switchRow(settings, 'hang-images', 'Images', 'They hang like screenshots.'));
        copied.add(switchRow(settings, 'hang-text', 'Text', 'As a note, with its first line as the title.'));
        copied.add(switchRow(settings, 'hang-links', 'Web addresses', 'As a link showing the site and the path.'));
        page.add(copied);

        const more = new Adw.PreferencesGroup({
            title: 'More folders',
            description: 'New pictures and videos saved in these hang too.',
        });
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', tooltip_text: 'Add a folder', css_classes: ['flat'], valign: Gtk.Align.CENTER});
        more.set_header_suffix(add);
        let rows = [];
        const sync = () => {
            for (const row of rows)
                more.remove(row);
            rows = settings.get_strv('watch-folders').map(dir => {
                const row = new Adw.ActionRow({title: GLib.path_get_basename(dir), subtitle: nice(dir)});
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Stop watching'});
                remove.connect('clicked', () => settings.set_strv('watch-folders', settings.get_strv('watch-folders').filter(d => d !== dir)));
                row.add_suffix(remove);
                more.add(row);
                return row;
            });
            if (!rows.length) {
                const row = new Adw.ActionRow({title: 'None yet', css_classes: ['dim-label']});
                more.add(row);
                rows.push(row);
            }
        };
        sync();
        settings.connect('changed::watch-folders', sync);
        add.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Watch a folder'});
            dialog.select_folder(host.window, null, (_d, res) => {
                try {
                    const path = dialog.select_folder_finish(res)?.get_path();
                    const now = settings.get_strv('watch-folders');
                    if (path && !now.includes(path))
                        settings.set_strv('watch-folders', [...now, path]);
                } catch (_e) {
                    // cancelled
                }
            });
        });
        page.add(more);
        return page;
    }

    // ------------------------------------------------------------ the line

    _linePage(host, settings) {
        const page = new Adw.PreferencesPage({title: 'The Line', icon_name: 'view-more-horizontal-symbolic'});

        const coming = new Adw.PreferencesGroup({title: 'Coming down'});
        const HOVER = [
            ['bar', 'Anywhere on the top bar'],
            ['edge', 'Top edge only'],
            ['off', 'Never'],
        ];
        const hoverMode = () => !settings.get_boolean('reveal-on-hover') ? 'off'
            : settings.get_boolean('reveal-edge-only') ? 'edge' : 'bar';
        const [hover, syncHover] = comboRow('Come down on hover', HOVER, hoverMode, v => {
            settings.set_boolean('reveal-on-hover', v !== 'off');
            settings.set_boolean('reveal-edge-only', v === 'edge');
        }, 'Where the pointer rests to bring the line down. With Never, use the shortcut or the clothespin.');
        for (const key of ['reveal-on-hover', 'reveal-edge-only'])
            settings.connect(`changed::${key}`, syncHover);
        coming.add(hover);
        const [delay, syncDelay] = comboRow('When', DELAYS, () => settings.get_int('reveal-delay'),
            v => settings.set_int('reveal-delay', v));
        settings.bind('reveal-on-hover', delay, 'sensitive', Gio.SettingsBindFlags.GET);
        settings.connect('changed::reveal-delay', syncDelay);
        coming.add(delay);
        coming.add(switchRow(settings, 'peek', 'Show each new screenshot',
            'The line comes down for a moment when a screenshot or recording hangs.'));
        page.add(coming);

        const look = new Adw.PreferencesGroup({title: 'Look'});
        const [size, syncSize] = comboRow('Size', SIZES, () => settings.get_string('size'), v => settings.set_string('size', v));
        settings.connect('changed::size', syncSize);
        look.add(size);
        const [rope, syncRope] = comboRow('Line', ROPES, () => settings.get_string('rope'), v => settings.set_string('rope', v));
        settings.connect('changed::rope', syncRope);
        look.add(rope);
        look.add(switchRow(settings, 'zoom-on-hover', 'Grow under the pointer'));
        look.add(switchRow(settings, 'sway', 'Sway on the clips'));
        look.add(switchRow(settings, 'sounds', 'Sounds', 'A clip when something hangs, a tick when you copy.'));
        look.add(switchRow(settings, 'show-indicator', 'Clothespin in the top bar'));
        page.add(look);

        const keep = new Adw.PreferencesGroup({title: 'Keeping'});
        const max = new Adw.SpinRow({
            title: 'How many items stay on the line',
            subtitle: 'The oldest fall off. Put Back brings them back.',
            adjustment: new Gtk.Adjustment({lower: 3, upper: 100, step_increment: 1, page_increment: 10}),
        });
        settings.bind('max-items', max, 'value', Gio.SettingsBindFlags.DEFAULT);
        keep.add(max);
        const where = new Adw.ActionRow({title: 'Where it is all kept', subtitle: dataDir().replace(GLib.get_home_dir(), '~'), activatable: true});
        where.add_suffix(new Gtk.Image({icon_name: 'folder-open-symbolic'}));
        where.connect('activated', () => {
            GLib.mkdir_with_parents(dataDir(), 0o700);
            Gtk.show_uri(host.window, Gio.File.new_for_path(dataDir()).get_uri(), Gdk.CURRENT_TIME);
        });
        keep.add(where);
        page.add(keep);
        return page;
    }

    // ------------------------------------------------------------ controls

    _controlsPage(host, settings) {
        const page = new Adw.PreferencesPage({title: 'Controls', icon_name: 'input-keyboard-symbolic'});
        const keys = new Adw.PreferencesGroup({title: 'Shortcuts'});
        for (const [key, label] of SHORTCUTS)
            keys.add(this._shortcutRow(host, settings, key, label));
        page.add(keys);

        const gestures = new Adw.PreferencesGroup({title: 'On the line'});
        for (const [what, does] of GESTURES) {
            const row = new Adw.ActionRow({title: does});
            row.add_prefix(new Gtk.Label({label: what, css_classes: ['heading'], width_chars: 16, xalign: 0}));
            gestures.add(row);
        }
        const search = new Adw.ActionRow({title: 'Type to keep only what matches; Return copies the newest, Esc closes'});
        search.add_prefix(new Gtk.Label({label: 'Searching', css_classes: ['heading'], width_chars: 16, xalign: 0}));
        gestures.add(search);
        page.add(gestures);
        return page;
    }

    _shortcutRow(host, settings, key, label) {
        const row = new Adw.ActionRow({title: label, activatable: true});
        const shown = new Gtk.ShortcutLabel({disabled_text: 'Off', valign: Gtk.Align.CENTER});
        const sync = () => (shown.accelerator = settings.get_strv(key)[0] ?? '');
        sync();
        settings.connect(`changed::${key}`, sync);
        row.add_suffix(shown);
        row.connect('activated', () => {
            const dialog = new Adw.Window({transient_for: host.window, modal: true, default_width: 420, default_height: 200, title: label});
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 28,
                margin_bottom: 28, margin_start: 28, margin_end: 28, valign: Gtk.Align.CENTER});
            box.append(new Gtk.Label({label: 'Press the new shortcut', css_classes: ['title-2']}));
            box.append(new Gtk.Label({label: 'Backspace turns it off. Esc cancels.', css_classes: ['dim-label']}));
            const view = new Adw.ToolbarView({content: box});
            view.add_top_bar(new Adw.HeaderBar());
            dialog.set_content(view);
            const controller = new Gtk.EventControllerKey();
            controller.connect('key-pressed', (_c, keyval, keycode, state) => {
                const mods = state & Gtk.accelerator_get_default_mod_mask();
                if (keyval === Gdk.KEY_Escape && mods === 0) {
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (keyval === Gdk.KEY_BackSpace && mods === 0) {
                    settings.set_strv(key, []);
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                const lower = Gdk.keyval_to_lower(keyval);
                const needed = Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK | Gdk.ModifierType.SUPER_MASK;
                if (!Gtk.accelerator_valid(lower, mods) || (mods & needed) === 0)
                    return Gdk.EVENT_STOP;
                settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, lower, keycode, mods)]);
                dialog.close();
                return Gdk.EVENT_STOP;
            });
            dialog.add_controller(controller);
            dialog.present();
        });
        return row;
    }

    // ------------------------------------------------------------ about

    _aboutPage(host, settings) {
        const window = host.window;
        const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});
        const head = new Adw.PreferencesGroup();
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, halign: Gtk.Align.CENTER});
        box.append(new Gtk.Image({file: GLib.build_filenamev([this.path, 'assets', 'icons', 'festoon.svg']), pixel_size: 96, margin_top: 12}));
        box.append(new Gtk.Label({label: 'Festoon', css_classes: ['title-1']}));
        box.append(new Gtk.Label({label: `Version ${this.version}`, css_classes: ['dim-label']}));
        box.append(new Gtk.Label({
            label: 'Your screenshots and the things you copy, on a line just under the top bar. Free and open source.',
            wrap: true, justify: Gtk.Justification.CENTER, max_width_chars: 48,
        }));
        head.add(box);
        page.add(head);

        const links = new Adw.PreferencesGroup();
        const link = (title, subtitle, uri) => {
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            row.connect('activated', () => Gtk.show_uri(window, uri, Gdk.CURRENT_TIME));
            return row;
        };
        links.add(link('Website', 'dabane-ghassan.github.io/festoon', 'https://dabane-ghassan.github.io/festoon/'));
        links.add(link('Source code', 'github.com/dabane-ghassan/festoon', 'https://github.com/dabane-ghassan/festoon'));
        links.add(link('License', 'MIT', 'https://github.com/dabane-ghassan/festoon/blob/main/LICENSE'));
        page.add(links);

        const update = new Adw.PreferencesGroup();
        const updateRow = new Adw.ActionRow({
            title: 'Update Festoon',
            subtitle: 'Downloads and installs the latest version. Same as running “festoon update”.',
            activatable: true,
        });
        const spinner = new Gtk.Spinner({visible: false});
        updateRow.add_suffix(spinner);
        updateRow.connect('activated', () => {
            if (spinner.visible)
                return;
            spinner.visible = true;
            spinner.start();
            const done = message => {
                spinner.stop();
                spinner.visible = false;
                host.toast(new Adw.Toast({title: message, timeout: 8}));
            };
            try {
                const url = 'https://raw.githubusercontent.com/dabane-ghassan/festoon/main/install.sh';
                const proc = Gio.Subprocess.new(['sh', '-c', `curl -fsSL ${url} | sh`],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.wait_check_async(null, (_p, result) => {
                    try {
                        proc.wait_check_finish(result);
                        done('Updated. Log out and back in to start using the new version.');
                    } catch (_e) {
                        done('The update did not finish. Check your connection and try again.');
                    }
                });
            } catch (_e) {
                done('Could not start the update.');
            }
        });
        update.add(updateRow);
        page.add(update);

        const danger = new Adw.PreferencesGroup();
        const reset = new Adw.ActionRow({title: 'Reset all settings', subtitle: 'What hangs on the line stays.', activatable: true});
        reset.connect('activated', () => {
            for (const key of RESET_KEYS)
                settings.reset(key);
            host.toast(new Adw.Toast({title: 'Settings reset.'}));
        });
        danger.add(reset);
        page.add(danger);
        return page;
    }
}
