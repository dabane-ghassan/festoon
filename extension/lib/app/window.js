// The Festoon window: a sidebar, a Home page with the line itself, and the settings pages.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {LineView} from '../line/view.js';
import {Engine} from './engine.js';
import {GESTURES, Pages, accelLabel} from './pages.js';

const ACCENT = '#2F6FDE';

const CSS = `
@define-color accent_bg_color ${ACCENT};
@define-color accent_color #2A62C6;
@define-color accent_fg_color #ffffff;

.festoon-side { background: #1B1A17; color: #F4EDE0; }
.festoon-side headerbar { background: none; box-shadow: none; color: #F4EDE0; }
.festoon-brand { font-weight: 800; font-size: 1.15em; letter-spacing: -0.01em; }
.festoon-nav { background: none; padding: 6px 10px; }
.festoon-nav row { border-radius: 12px; padding: 10px 12px; margin: 2px 0; color: alpha(#F4EDE0, 0.72); font-weight: 600; }
.festoon-nav row:hover { background: alpha(#F4EDE0, 0.08); }
.festoon-nav row:selected { background: alpha(#F4EDE0, 0.14); color: #F4EDE0; }

.festoon-stage { border-radius: 26px; background: radial-gradient(ellipse at 50% 0%, #2c3f63 0%, #1B1A17 70%); }
.festoon-state { font-weight: 800; font-size: 1.9em; letter-spacing: -0.02em; }
.festoon-power { border-radius: 999px; padding: 12px 30px; font-weight: 700; font-size: 1.05em; }
.festoon-round { border-radius: 999px; padding: 12px 18px; font-weight: 600; }
.festoon-chip { border-radius: 999px; padding: 6px 14px; background: alpha(currentColor, 0.07); font-size: 0.9em; }
.festoon-chip-key { font-weight: 700; }
.festoon-setup { border-radius: 18px; padding: 16px 18px; background: alpha(${ACCENT}, 0.14); }
`;

const CSS_VARS = `
window.festoon { --accent-bg-color: ${ACCENT}; --accent-color: #2A62C6; --accent-fg-color: #ffffff; }
`;

const NAV = [
    ['home', 'Home', 'go-home-symbolic'],
    ['hanging', 'Hanging', 'insert-image-symbolic'],
    ['line', 'The Line', 'view-more-horizontal-symbolic'],
    ['controls', 'Controls', 'input-keyboard-symbolic'],
    ['about', 'About', 'help-about-symbolic'],
];

export function buildAppWindow(app, path, version, settings) {
    const display = Gdk.Display.get_default();
    const provider = new Gtk.CssProvider();
    const css = CSS + (Gtk.get_minor_version() >= 16 ? CSS_VARS : '');
    if (provider.load_from_string)
        provider.load_from_string(css);
    else
        provider.load_from_data(css, -1);
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    Gtk.IconTheme.get_for_display(display).add_search_path(GLib.build_filenamev([path, 'assets', 'icons']));

    const window = new Adw.ApplicationWindow({
        application: app, title: 'Festoon', default_width: 1000, default_height: 720,
        width_request: 360, height_request: 480,
    });
    window.add_css_class('festoon');
    const toasts = new Adw.ToastOverlay();
    const host = {window, toast: t => toasts.add_toast(t)};
    const [hanging, line, controls, about] = new Pages(path, version).build(host, settings);
    const engine = new Engine();
    window.connect('close-request', () => {
        engine.destroy();
        view.destroy();
        return false;
    });

    // ---------------------------------------------------------- home: the line itself
    const view = new LineView(settings, path);
    view.set_size_request(-1, 270);
    view.vexpand = false;
    view.onAction = (action, item) => {
        if (action === 'copy') {
            engine.line('Copy', item.id);
            view.flash(item);
        } else if (action === 'letgo') {
            engine.line('LetGo', item.id);
        } else if (action === 'open') {
            const uri = item.kind === 'link' ? item.url : Gio.File.new_for_path(item.path).get_uri();
            Gtk.show_uri(window, uri, Gdk.CURRENT_TIME);
        }
    };
    const stage = new Gtk.Box({css_classes: ['festoon-stage'], overflow: Gtk.Overflow.HIDDEN});
    stage.append(view);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        view.setDown(true);
        return GLib.SOURCE_REMOVE;
    });

    const state = new Gtk.Label({css_classes: ['festoon-state'], xalign: 0});
    const detail = new Gtk.Label({css_classes: ['dim-label'], xalign: 0, wrap: true});
    const words = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true, valign: Gtk.Align.CENTER});
    words.append(state);
    words.append(detail);
    const show = new Gtk.Button({label: 'Show the Line', css_classes: ['festoon-power', 'suggested-action'], valign: Gtk.Align.CENTER});
    show.connect('clicked', () => engine.shell('Show'));
    const search = new Gtk.Button({icon_name: 'system-search-symbolic', tooltip_text: 'Search the line', css_classes: ['festoon-round'], valign: Gtk.Align.CENTER});
    search.connect('clicked', () => engine.shell('Search'));
    const menu = new Gio.Menu();
    menu.append('Put Back', 'home.putback');
    menu.append('Take Everything Down', 'home.clear');
    const more = new Gtk.MenuButton({icon_name: 'view-more-symbolic', menu_model: menu, css_classes: ['festoon-round'], valign: Gtk.Align.CENTER});
    const actions = new Gio.SimpleActionGroup();
    const putBack = new Gio.SimpleAction({name: 'putback'});
    putBack.connect('activate', () => engine.line('PutBack'));
    const clear = new Gio.SimpleAction({name: 'clear'});
    clear.connect('activate', () => engine.line('Clear'));
    actions.add_action(putBack);
    actions.add_action(clear);
    window.insert_action_group('home', actions);

    const bar = new Gtk.Box({spacing: 10});
    bar.append(words);
    bar.append(more);
    bar.append(search);
    bar.append(show);

    const setup = new Gtk.Label({
        label: 'One more step: log out and back in once, so GNOME can load Festoon. After that, the line is under the top bar whenever you want it.',
        wrap: true, xalign: 0, css_classes: ['festoon-setup'], visible: false,
    });

    const chips = Adw.WrapBox ? new Adw.WrapBox({child_spacing: 8, line_spacing: 8}) : new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE, column_spacing: 8, row_spacing: 8, max_children_per_line: 6, homogeneous: false,
    });
    for (const [key, text] of GESTURES.slice(0, 6)) {
        const b = new Gtk.Box({spacing: 7, css_classes: ['festoon-chip']});
        b.append(new Gtk.Label({label: key, css_classes: ['festoon-chip-key']}));
        b.append(new Gtk.Label({label: text.charAt(0).toLowerCase() + text.slice(1), css_classes: ['dim-label']}));
        chips.append(b);
    }

    const homeBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 20,
        margin_top: 8, margin_bottom: 28, margin_start: 28, margin_end: 28});
    homeBox.append(stage);
    homeBox.append(bar);
    homeBox.append(setup);
    homeBox.append(chips);
    const home = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER,
        child: new Adw.Clamp({maximum_size: 860, child: homeBox})});

    const sync = (s, items) => {
        const ready = s !== null;
        setup.visible = !ready;
        for (const b of [show, search, more])
            b.sensitive = ready;
        putBack.enabled = ready && !!s?.canPutBack;
        clear.enabled = ready && (s?.count ?? 0) > 0;
        view.setItems(items.map(i => ({...i, text: i.text || ''})));
        const n = s?.count ?? 0;
        state.label = !ready ? 'The line is not up yet' : n === 0 ? 'The line is empty' : n === 1 ? 'One thing on the line' : `${n} things on the line`;
        const keys = accelLabel(settings.get_strv('show-shortcut')[0]);
        const how = settings.get_boolean('reveal-on-hover') ? 'Rest the pointer on the top bar' : 'Click the clothespin in the top bar';
        detail.label = `${how}${keys ? `, or press ${keys}` : ''}, and it comes down.`;
        show.label = s?.down ? 'Put It Away' : 'Show the Line';
    };
    engine.watch(sync);
    for (const key of ['show-shortcut', 'reveal-on-hover'])
        settings.connect(`changed::${key}`, () => sync(engine.state, engine.items));

    // ---------------------------------------------------------- layout
    const stack = new Gtk.Stack({transition_type: Gtk.StackTransitionType.CROSSFADE, transition_duration: 120});
    const content = {home, hanging, line, controls, about};
    for (const [id] of NAV)
        stack.add_named(content[id], id);

    const nav = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.SINGLE, css_classes: ['festoon-nav']});
    for (const [id, label, icon] of NAV) {
        const row = new Gtk.Box({spacing: 12});
        row.append(new Gtk.Image({icon_name: icon}));
        row.append(new Gtk.Label({label, xalign: 0}));
        const item = new Gtk.ListBoxRow({child: row});
        item._id = id;
        nav.append(item);
    }

    const brand = new Gtk.Box({spacing: 10});
    brand.append(new Gtk.Image({file: GLib.build_filenamev([path, 'assets', 'icons', 'festoon.svg']), pixel_size: 28}));
    brand.append(new Gtk.Label({label: 'Festoon', css_classes: ['festoon-brand']}));
    const sideHeader = new Adw.HeaderBar({title_widget: new Gtk.Box(), show_title: false});
    sideHeader.pack_start(brand);
    const sideBody = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    sideBody.append(nav);
    const side = new Adw.ToolbarView({content: sideBody, css_classes: ['festoon-side']});
    side.add_top_bar(sideHeader);

    const main = new Adw.ToolbarView({content: stack});
    const title = new Adw.WindowTitle({title: 'Home'});
    main.add_top_bar(new Adw.HeaderBar({title_widget: title}));

    const split = new Adw.NavigationSplitView({
        sidebar: new Adw.NavigationPage({title: 'Festoon', child: side}),
        content: new Adw.NavigationPage({title: 'Home', child: main, tag: 'content'}),
        min_sidebar_width: 210, max_sidebar_width: 240,
    });
    nav.connect('row-selected', (_l, row) => {
        if (!row)
            return;
        stack.visible_child_name = row._id;
        const label = NAV.find(n => n[0] === row._id)[1];
        title.title = label;
        split.content.title = label;
        split.show_content = true;
    });
    nav.select_row(nav.get_row_at_index(0));
    split.show_content = false;

    const narrow = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 620sp')});
    narrow.add_setter(split, 'collapsed', true);
    window.add_breakpoint(narrow);

    toasts.set_child(split);
    window.set_content(toasts);
    return window;
}
