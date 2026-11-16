// The windows a gesture can open: Markup for pictures, an editor for notes, and Quick Look.

import Adw from 'gi://Adw';
import Cairo from 'cairo';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {linkParts} from './store.js';

const COLORS = [
    ['Red', '#E5482D'], ['Yellow', '#F5C542'], ['Green', '#3FA34D'],
    ['Blue', '#2F6FDE'], ['Black', '#1B1A17'], ['White', '#FFFFFF'],
];

const TOOLS = [
    ['pen', 'Pen', 'festoon-pen-symbolic'],
    ['highlight', 'Highlighter', 'festoon-highlight-symbolic'],
    ['arrow', 'Arrow', 'festoon-arrow-symbolic'],
    ['box', 'Box', 'festoon-box-symbolic'],
    ['redact', 'Hide', 'festoon-redact-symbolic'],
];

const CSS = `
.festoon-swatch { min-width: 18px; min-height: 18px; padding: 0; border-radius: 999px; border: 2px solid alpha(currentColor, 0.15); }
.festoon-swatch:checked { border-color: currentColor; }
.festoon-canvas { background: #2a2925; }
.festoon-look-note { font-size: 1.05em; padding: 18px 22px; }
.festoon-look-site { font-size: 2em; font-weight: 800; }
`;

let cssLoaded = false;
function loadCss() {
    if (cssLoaded)
        return;
    cssLoaded = true;
    const provider = new Gtk.CssProvider();
    if (provider.load_from_string)
        provider.load_from_string(CSS);
    else
        provider.load_from_data(CSS, -1);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

function parse(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** Draw one mark onto a cairo context in picture coordinates. `m.unit` is one screen pixel. */
function drawMark(cr, m) {
    const [r, g, b] = parse(m.color);
    cr.save();
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    switch (m.tool) {
    case 'pen':
    case 'highlight': {
        if (m.tool === 'highlight') {
            cr.setOperator(Cairo.Operator.MULTIPLY);
            cr.setSourceRGBA(r, g, b, 0.45);
            cr.setLineWidth(18 * m.unit);
            cr.setLineCap(Cairo.LineCap.SQUARE);
        } else {
            cr.setSourceRGB(r, g, b);
            cr.setLineWidth(4 * m.unit);
        }
        const [first, ...rest] = m.points;
        cr.moveTo(...first);
        for (const p of rest)
            cr.lineTo(...p);
        if (!rest.length)
            cr.lineTo(first[0] + 0.1, first[1]);
        cr.stroke();
        break;
    }
    case 'arrow': {
        const [[x0, y0], [x1, y1]] = [m.points[0], m.points[m.points.length - 1]];
        cr.setSourceRGB(r, g, b);
        cr.setLineWidth(4.5 * m.unit);
        const a = Math.atan2(y1 - y0, x1 - x0);
        const head = 18 * m.unit;
        cr.moveTo(x0, y0);
        cr.lineTo(x1 - Math.cos(a) * head * 0.6, y1 - Math.sin(a) * head * 0.6);
        cr.stroke();
        cr.moveTo(x1, y1);
        cr.lineTo(x1 - Math.cos(a - 0.45) * head, y1 - Math.sin(a - 0.45) * head);
        cr.lineTo(x1 - Math.cos(a + 0.45) * head, y1 - Math.sin(a + 0.45) * head);
        cr.closePath();
        cr.fill();
        break;
    }
    case 'box':
    case 'redact': {
        const [[x0, y0], [x1, y1]] = [m.points[0], m.points[m.points.length - 1]];
        const x = Math.min(x0, x1);
        const y = Math.min(y0, y1);
        const w = Math.abs(x1 - x0);
        const h = Math.abs(y1 - y0);
        if (m.tool === 'redact') {
            cr.setSourceRGB(0.106, 0.102, 0.090);
            cr.rectangle(x, y, w, h);
            cr.fill();
        } else {
            cr.setSourceRGB(r, g, b);
            cr.setLineWidth(4 * m.unit);
            const k = Math.min(10 * m.unit, w / 2, h / 2);
            cr.newSubPath();
            cr.arc(x + w - k, y + k, k, -Math.PI / 2, 0);
            cr.arc(x + w - k, y + h - k, k, 0, Math.PI / 2);
            cr.arc(x + k, y + h - k, k, Math.PI / 2, Math.PI);
            cr.arc(x + k, y + k, k, Math.PI, 1.5 * Math.PI);
            cr.closePath();
            cr.stroke();
        }
        break;
    }
    }
    cr.restore();
}

/** Press and hold on a screenshot or image: draw on it, then Done copies the result. */
export const MarkupWindow = GObject.registerClass(
class MarkupWindow extends Adw.Window {
    _init(app, item, onDone) {
        super._init({application: app, title: 'Markup', default_width: 1100, default_height: 760});
        loadCss();
        this._item = item;
        this._onDone = onDone;
        this._marks = [];
        this._undone = [];
        this._tool = 'pen';
        this._color = COLORS[0][1];
        this._current = null;
        this._pixbuf = GdkPixbuf.Pixbuf.new_from_file(item.path);
        this._fit = {s: 1, x: 0, y: 0};

        const header = new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: 'Markup', subtitle: item.title ?? ''})});
        const cancel = new Gtk.Button({label: 'Cancel'});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        const done = new Gtk.Button({label: 'Done', css_classes: ['suggested-action'], tooltip_text: 'Save, and copy the result (Ctrl+Enter)'});
        done.connect('clicked', () => this._finish());
        header.pack_end(done);

        const bar = new Gtk.Box({spacing: 4, halign: Gtk.Align.CENTER, margin_top: 6, margin_bottom: 6});
        let group = null;
        this._toolButtons = {};
        for (const [id, label, icon] of TOOLS) {
            const b = new Gtk.ToggleButton({icon_name: icon, tooltip_text: label, css_classes: ['flat'], group});
            group ??= b;
            b.connect('toggled', () => b.active && (this._tool = id));
            this._toolButtons[id] = b;
            bar.append(b);
        }
        this._toolButtons.pen.active = true;
        bar.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL, margin_start: 8, margin_end: 8}));
        let swatchGroup = null;
        for (const [name, hex] of COLORS) {
            const s = new Gtk.ToggleButton({tooltip_text: name, css_classes: ['festoon-swatch'], valign: Gtk.Align.CENTER, group: swatchGroup});
            swatchGroup ??= s;
            const provider = new Gtk.CssProvider();
            const css = `button { background: ${hex}; color: ${hex === '#FFFFFF' ? '#888' : hex}; }`;
            if (provider.load_from_string)
                provider.load_from_string(css);
            else
                provider.load_from_data(css, -1);
            s.get_style_context().add_provider(provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
            s.connect('toggled', () => s.active && (this._color = hex));
            if (hex === this._color)
                s.active = true;
            bar.append(s);
        }
        bar.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL, margin_start: 8, margin_end: 8}));
        const undo = new Gtk.Button({icon_name: 'edit-undo-symbolic', tooltip_text: 'Undo (Ctrl+Z)', css_classes: ['flat']});
        undo.connect('clicked', () => this._undo());
        const redo = new Gtk.Button({icon_name: 'edit-redo-symbolic', tooltip_text: 'Redo (Ctrl+Shift+Z)', css_classes: ['flat']});
        redo.connect('clicked', () => this._redo());
        bar.append(undo);
        bar.append(redo);

        this._area = new Gtk.DrawingArea({hexpand: true, vexpand: true, css_classes: ['festoon-canvas']});
        this._area.set_draw_func((_a, cr, w, h) => this._draw(cr, w, h));
        this._area.set_cursor_from_name('crosshair');
        const drag = new Gtk.GestureDrag();
        drag.connect('drag-begin', (_g, x, y) => this._begin(x, y));
        drag.connect('drag-update', (g, dx, dy) => {
            const [, sx, sy] = g.get_start_point();
            this._extend(sx + dx, sy + dy);
        });
        drag.connect('drag-end', () => this._end());
        this._area.add_controller(drag);

        const view = new Adw.ToolbarView({content: this._area});
        view.add_top_bar(header);
        view.add_top_bar(bar);
        this.set_content(view);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, state) => {
            const ctrl = state & Gdk.ModifierType.CONTROL_MASK;
            const shift = state & Gdk.ModifierType.SHIFT_MASK;
            if (ctrl && (keyval === Gdk.KEY_z || keyval === Gdk.KEY_Z)) {
                if (shift)
                    this._redo();
                else
                    this._undo();
                return true;
            }
            if (ctrl && (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_s)) {
                this._finish();
                return true;
            }
            if (keyval === Gdk.KEY_Escape && !this._marks.length) {
                this.close();
                return true;
            }
            const n = keyval - Gdk.KEY_1;
            if (!ctrl && n >= 0 && n < TOOLS.length) {
                this._toolButtons[TOOLS[n][0]].active = true;
                return true;
            }
            return false;
        });
        this.add_controller(keys);
    }

    _toPicture(x, y) {
        const {s, x: ox, y: oy} = this._fit;
        return [(x - ox) / s, (y - oy) / s];
    }

    _begin(x, y) {
        this._current = {tool: this._tool, color: this._color, unit: 1 / this._fit.s, points: [this._toPicture(x, y)]};
        this._undone = [];
        this._area.queue_draw();
    }

    _extend(x, y) {
        if (!this._current)
            return;
        const p = this._toPicture(x, y);
        if (this._current.tool === 'pen' || this._current.tool === 'highlight')
            this._current.points.push(p);
        else
            this._current.points[1] = p;
        this._area.queue_draw();
    }

    _end() {
        const m = this._current;
        this._current = null;
        if (m && (m.points.length > 1 || m.tool === 'pen'))
            this._marks.push(m);
        this._area.queue_draw();
    }

    _undo() {
        if (this._marks.length)
            this._undone.push(this._marks.pop());
        this._area.queue_draw();
    }

    _redo() {
        if (this._undone.length)
            this._marks.push(this._undone.pop());
        this._area.queue_draw();
    }

    _draw(cr, w, h) {
        const pw = this._pixbuf.get_width();
        const ph = this._pixbuf.get_height();
        const pad = 24;
        const s = Math.min((w - pad * 2) / pw, (h - pad * 2) / ph, 1.5);
        const x = (w - pw * s) / 2;
        const y = (h - ph * s) / 2;
        this._fit = {s, x, y};
        cr.save();
        cr.translate(x, y);
        cr.scale(s, s);
        cr.rectangle(0, 0, pw, ph);
        cr.clip();
        Gdk.cairo_set_source_pixbuf(cr, this._pixbuf, 0, 0);
        cr.paint();
        for (const m of this._marks)
            drawMark(cr, m);
        if (this._current)
            drawMark(cr, this._current);
        cr.restore();
        cr.$dispose();
    }

    _finish() {
        if (!this._marks.length) {
            this.close();
            return;
        }
        const marks = this._marks;
        const pixbuf = this._pixbuf;
        this._onDone(dest => {
            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, pixbuf.get_width(), pixbuf.get_height());
            const cr = new Cairo.Context(surface);
            Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
            cr.paint();
            for (const m of marks)
                drawMark(cr, m);
            cr.$dispose();
            surface.writeToPNG(dest);
            surface.finish();
        });
        this.close();
    }
});

/** Press and hold on a note: change its text. */
export const NoteWindow = GObject.registerClass(
class NoteWindow extends Adw.Window {
    _init(app, item, onDone) {
        super._init({application: app, title: item.title || 'Note', default_width: 560, default_height: 480});
        loadCss();
        const header = new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: 'Note', subtitle: item.title ?? ''})});
        const cancel = new Gtk.Button({label: 'Cancel'});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        const done = new Gtk.Button({label: 'Done', css_classes: ['suggested-action'], tooltip_text: 'Save, and copy the note (Ctrl+Enter)'});
        header.pack_end(done);
        const text = new Gtk.TextView({wrap_mode: Gtk.WrapMode.WORD_CHAR, css_classes: ['festoon-look-note'],
            top_margin: 14, bottom_margin: 14, left_margin: 18, right_margin: 18});
        text.buffer.text = item.text;
        const finish = () => {
            const value = text.buffer.text;
            if (value.trim() && value !== item.text)
                onDone(value);
            this.close();
        };
        done.connect('clicked', finish);
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, state) => {
            if ((state & Gdk.ModifierType.CONTROL_MASK) && (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_s)) {
                finish();
                return true;
            }
            if (keyval === Gdk.KEY_Escape) {
                this.close();
                return true;
            }
            return false;
        });
        this.add_controller(keys);
        const view = new Adw.ToolbarView({content: new Gtk.ScrolledWindow({child: text})});
        view.add_top_bar(header);
        this.set_content(view);
        text.grab_focus();
    }
});

/** A big look at an item. Space or Esc closes it. */
export const QuickLook = GObject.registerClass(
class QuickLook extends Adw.Window {
    _init(app, item, {copy, open}) {
        const display = Gdk.Display.get_default();
        const monitor = display.get_monitors().get_item(0);
        const geo = monitor?.get_geometry();
        const W = Math.round((geo?.width ?? 1280) * 0.7);
        const H = Math.round((geo?.height ?? 800) * 0.75);
        super._init({application: app, title: item.title || 'Quick Look', default_width: W, default_height: H});
        loadCss();

        let content;
        switch (item.kind) {
        case 'screenshot':
        case 'image':
            content = new Gtk.Picture({file: Gio.File.new_for_path(item.path), content_fit: Gtk.ContentFit.CONTAIN,
                margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12});
            break;
        case 'recording': {
            const video = new Gtk.Video({file: Gio.File.new_for_path(item.path), autoplay: true});
            content = video;
            break;
        }
        case 'note': {
            const text = new Gtk.TextView({editable: false, cursor_visible: false, wrap_mode: Gtk.WrapMode.WORD_CHAR,
                css_classes: ['festoon-look-note'], top_margin: 14, bottom_margin: 14, left_margin: 18, right_margin: 18});
            text.buffer.text = item.text;
            content = new Gtk.ScrolledWindow({child: text});
            break;
        }
        default: {
            const {site, path} = linkParts(item.url);
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER});
            box.append(new Gtk.Label({label: site, css_classes: ['festoon-look-site']}));
            box.append(new Gtk.Label({label: path || '/', css_classes: ['dim-label'], wrap: true, selectable: true, max_width_chars: 80}));
            box.append(new Gtk.Label({label: item.url, css_classes: ['dim-label', 'caption'], wrap: true, selectable: true, max_width_chars: 90, margin_top: 16}));
            content = box;
        }
        }

        const header = new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: item.title || 'Quick Look'})});
        const copyButton = new Gtk.Button({icon_name: 'edit-copy-symbolic', tooltip_text: 'Copy'});
        copyButton.connect('clicked', () => {
            copy();
            this.close();
        });
        const openButton = new Gtk.Button({label: item.kind === 'link' ? 'Open in Browser' : 'Open'});
        openButton.connect('clicked', () => {
            open();
            this.close();
        });
        header.pack_end(openButton);
        header.pack_end(copyButton);
        const view = new Adw.ToolbarView({content});
        view.add_top_bar(header);
        this.set_content(view);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval) => {
            if (keyval === Gdk.KEY_Escape || keyval === Gdk.KEY_space) {
                this.close();
                return true;
            }
            return false;
        });
        keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        this.add_controller(keys);
    }
});

