// The line itself: a cord across the top of the screen with every item hanging from a clip.
//
// One widget draws everything with GTK's scene graph (textures and text go to the GPU), and
// a few springs make it move: the line drops down and settles, items swing on their clips,
// slide along when one is added or let go, and grow a little under the pointer.

import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {SIZES} from '../common.js';
import {linkParts} from './store.js';

const KIND_NAMES = {screenshot: 'Screenshot', image: 'Image', recording: 'Recording', note: 'Note', link: 'Link'};
const GAP = 26;
const MARGIN = 64;
const ROPE_TOP = 20;

function rgba(r, g, b, a = 1) {
    return new Gdk.RGBA({red: r / 255, green: g / 255, blue: b / 255, alpha: a});
}
const rect = (x, y, w, h) => new Graphene.Rect().init(x, y, w, h);
const point = (x, y) => new Graphene.Point({x, y});
function rounded(x, y, w, h, r) {
    const rr = new Gsk.RoundedRect();
    rr.init_from_rect(rect(x, y, w, h), r);
    return rr;
}

const PAPER = rgba(255, 251, 234);
const INK = rgba(29, 29, 31);
const DIM = rgba(29, 29, 31, 0.58);
const WHITE = rgba(255, 255, 255);
const SHADOW = rgba(0, 0, 0, 0.32);

function hashHue(s) {
    let h = 0;
    for (const c of s)
        h = (h * 31 + c.codePointAt(0)) % 360;
    return h;
}

function hsl(h, s, l) {
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return rgba(f(0) * 255, f(8) * 255, f(4) * 255);
}

export function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45)
        return 'just now';
    if (s < 3600)
        return `${Math.round(s / 60)} min ago`;
    if (s < 86400)
        return `${Math.round(s / 3600)} h ago`;
    const d = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    return d.format('%e %b').trim();
}

function duration(us) {
    const s = Math.round(us / 1e6);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A damped spring towards `target`. */
class Spring {
    constructor(value, stiffness, damping) {
        this.value = value;
        this.target = value;
        this.v = 0;
        this.k = stiffness;
        this.c = damping;
    }

    step(dt) {
        const a = -this.k * (this.value - this.target) - this.c * this.v;
        this.v += a * dt;
        this.value += this.v * dt;
        if (Math.abs(this.v) < 0.001 && Math.abs(this.value - this.target) < 0.0005) {
            this.value = this.target;
            this.v = 0;
        }
    }

    get settled() {
        return this.v === 0 && this.value === this.target;
    }

    snap(v) {
        this.value = this.target = v;
        this.v = 0;
    }
}

/** One item on the line, with its own motion. */
class Card {
    constructor(item) {
        this.item = item;
        this.x = new Spring(0, 150, 24);
        this.swing = new Spring(0, 42, 1.6);       // angle in radians, pendulum-like
        this.zoom = new Spring(1, 320, 26);
        this.drop = new Spring(0, 130, 13);        // vertical offset while it is being hung
        this.alpha = new Spring(1, 200, 28);
        this.hover = new Spring(0, 260, 30);       // shows the cross and the caption
        this.flash = 0;                            // seconds left of the "Copied" badge
        this.falling = null;                       // {vy, y, spin} once let go
        this.placed = false;
        this.texture = null;
        this.paintable = null;
        this.aspect = item.kind === 'recording' ? 16 / 9 : 16 / 10;
        this.w = 0;
        this.h = 0;
        this.layouts = null;
    }

    get settled() {
        return this.x.settled && this.swing.settled && this.zoom.settled && this.drop.settled &&
            this.alpha.settled && this.hover.settled && !this.flash && !this.falling;
    }
}

export const LineView = GObject.registerClass(
class LineView extends Gtk.Widget {
    _init(settings, extensionDir) {
        super._init({hexpand: true, vexpand: true, focusable: true});
        this._settings = settings;
        this._dir = extensionDir;
        this.cards = new Map();
        this._order = [];               // ids, newest first, as on the line
        this._dying = [];               // cards falling off
        this.reveal = new Spring(0, 150, 15.5);
        this.scroll = new Spring(0, 220, 30);
        this._bob = new Spring(0, 90, 6);
        this._filter = null;            // Set of ids while searching
        this._pointer = null;           // [x, y] in widget coordinates
        this._pointerV = 0;
        this.hovered = null;            // Card
        this._tick = 0;
        this._last = 0;
        this._pin = null;
        this.message = '';              // shown when the line is empty

        // callbacks set by the line controller
        this.onAction = null;           // (action, item, extra) => void
        this.onPointer = null;          // (inside) => void
        this.contentFor = null;         // (item) => Gdk.ContentProvider | null
        this.onDrag = null;             // (dragging, item) => void

        this._loadPin();
        this._controllers();
        for (const key of ['size', 'zoom-on-hover', 'sway'])
            settings.connect(`changed::${key}`, () => this._relayout());
    }

    get size() {
        return SIZES[this._settings.get_string('size')] ?? SIZES.medium;
    }

    // ------------------------------------------------------------- items

    /** Make the cards match the items, newest first. `fresh` is the id of a just-hung item. */
    setItems(items, fresh = null) {
        const ids = new Set(items.map(i => i.id));
        for (const [id, card] of this.cards) {
            if (!ids.has(id))
                this._fall(card);
        }
        for (const item of items) {
            let card = this.cards.get(item.id);
            if (!card) {
                card = new Card(item);
                this.cards.set(item.id, card);
                this._load(card);
                if (item.id === fresh || (this._order.length && fresh === '*'))
                    card.fresh = true;
            } else if (card.item !== item || card.item.path !== item.path || card.item.text !== item.text) {
                const reload = card.item.path !== item.path || card.item.kind !== item.kind;
                card.item = item;
                card.layouts = null;
                if (reload)
                    this._load(card);
            }
        }
        this._order = items.map(i => i.id);
        this._relayout();
    }

    _fall(card) {
        this.cards.delete(card.item.id);
        if (this.hovered === card)
            this.hovered = null;
        if (this.reveal.value < 0.05 || !card.placed) {
            return;
        }
        card.falling = {vy: -120, y: 0, spin: (Math.random() - 0.5) * 3};
        this._dying.push(card);
        this._wake();
    }

    _load(card) {
        const item = card.item;
        card.texture = null;
        card.paintable = null;
        if (item.kind === 'recording') {
            this._loadVideo(card);
            return;
        }
        if (item.kind !== 'screenshot' && item.kind !== 'image')
            return;
        const px = Math.round(this.size * 2.8);
        const file = Gio.File.new_for_path(item.path);
        file.read_async(GLib.PRIORITY_LOW, null, (_f, res) => {
            let stream;
            try {
                stream = file.read_finish(res);
            } catch (_e) {
                return;
            }
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, px * 2, px, true, null, (_s, r) => {
                try {
                    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(r);
                    card.texture = Gdk.Texture.new_for_pixbuf(pixbuf);
                    card.aspect = pixbuf.get_width() / pixbuf.get_height();
                    this._relayout();
                } catch (_e) {
                    // not a picture after all: drawn as a blank frame
                }
                stream.close_async(GLib.PRIORITY_LOW, null, null);
            });
        });
    }

    _loadVideo(card) {
        let media;
        try {
            media = Gtk.MediaFile.new_for_filename(card.item.path);
        } catch (_e) {
            return;
        }
        media.set_muted(true);
        card.media = media;
        const ready = () => {
            if (!media.get_prepared())
                return;
            const w = media.get_intrinsic_width();
            const h = media.get_intrinsic_height();
            if (w > 0 && h > 0)
                card.aspect = w / h;
            card.duration = media.get_duration();
            card.paintable = media;
            this._relayout();
        };
        media.connect('notify::prepared', ready);
        media.connect('invalidate-contents', () => {
            if (card.paintable)
                this.queue_draw();
        });
        ready();
    }

    // ------------------------------------------------------------- geometry

    _measure(card) {
        const S = this.size;
        switch (card.item.kind) {
        case 'note':
            card.w = S * 0.92;
            card.h = S * 1.04;
            break;
        case 'link':
            card.w = S * 1.6;
            card.h = S * 0.62;
            break;
        default: {
            let w = S * card.aspect;
            let h = S;
            if (w > S * 1.9) {
                w = S * 1.9;
                h = Math.max(S * 0.5, w / card.aspect);
            } else if (w < S * 0.6) {
                w = S * 0.6;
            }
            card.w = w;
            card.h = h;
        }
        }
    }

    _visible(card) {
        return !this._filter || this._filter.has(card.item.id);
    }

    get contentWidth() {
        let x = 0;
        for (const id of this._order) {
            const card = this.cards.get(id);
            if (card && this._visible(card))
                x += card.w + GAP;
        }
        return x - GAP + MARGIN * 2;
    }

    _relayout() {
        const W = this.get_width() || 1200;
        let x = MARGIN;
        for (const id of this._order) {
            const card = this.cards.get(id);
            if (!card)
                continue;
            this._measure(card);
            const shown = this._visible(card);
            card.alpha.target = shown ? 1 : 0;
            if (!shown)
                continue;
            const cx = x + card.w / 2;
            card.x.target = cx;
            if (!card.placed) {
                card.placed = true;
                card.x.snap(cx);
                if (card.fresh) {
                    card.drop.value = -(card.h + 80);
                    card.drop.target = 0;
                    card.swing.v = (Math.random() < 0.5 ? -1 : 1) * 1.6;
                }
            }
            card.fresh = false;
            x += card.w + GAP;
        }
        const max = Math.max(0, this.contentWidth - W);
        this.scroll.target = Math.min(Math.max(this.scroll.target, 0), max);
        this._wake();
    }

    /** Height of the cord below the top of the window at x, without the drop. */
    _ropeY(x) {
        const W = this.get_width() || 1200;
        const u = Math.min(1, Math.max(0, x / W));
        const sag = Math.min(24, Math.max(8, W * 0.011));
        return ROPE_TOP + (sag + this._bob.value) * 4 * u * (1 - u);
    }

    /** Distance the whole line is pulled up when tucked away. */
    get _hiddenOffset() {
        return this.size * 1.4 + 70;
    }

    get lineY() {
        return (this.reveal.value - 1) * this._hiddenOffset;
    }

    /** Lowest point anything reaches while the line is down (for the input region). */
    get bandBottom() {
        const z = this._settings.get_boolean('zoom-on-hover') ? 1.32 : 1.0;
        let tallest = this.size * 0.62;
        for (const card of this.cards.values())
            tallest = Math.max(tallest, card.h);
        return Math.ceil(ROPE_TOP + 26 + tallest * z + 44);
    }

    _clipPoint(card) {
        const x = card.x.value - this.scroll.value;
        return [x, this._ropeY(x) + this.lineY + card.drop.value];
    }

    /** The card under (x, y) and whether the point is on its cross. */
    _hit(x, y) {
        const list = this._drawOrder().reverse();
        for (const card of list) {
            if (card.falling || card.alpha.value < 0.5)
                continue;
            const [cx, cy] = this._clipPoint(card);
            const a = -card.swing.value;
            const z = card.zoom.value;
            const dx = x - cx;
            const dy = y - cy;
            const lx = (dx * Math.cos(a) - dy * Math.sin(a)) / z;
            const ly = (dx * Math.sin(a) + dy * Math.cos(a)) / z;
            const top = 6;
            const [bx, by] = [card.w / 2 - 3, top + 3];
            if (card.hover.value > 0.5 && (lx - bx) ** 2 + (ly - by) ** 2 < 13 ** 2)
                return {card, cross: true};
            if (lx >= -card.w / 2 && lx <= card.w / 2 && ly >= -4 && ly <= top + card.h)
                return {card, cross: false};
        }
        return null;
    }

    /** Where a card is, in widget coordinates (for menus and drag icons). */
    cardRect(item) {
        const card = this.cards.get(item.id);
        if (!card)
            return null;
        const [cx, cy] = this._clipPoint(card);
        const z = card.zoom.value;
        return {x: cx - card.w * z / 2, y: cy, width: card.w * z, height: (card.h + 6) * z};
    }

    _drawOrder() {
        const list = this._order.map(id => this.cards.get(id)).filter(Boolean);
        if (this.hovered && list.includes(this.hovered)) {
            list.splice(list.indexOf(this.hovered), 1);
            list.push(this.hovered);
        }
        return list;
    }

    // ------------------------------------------------------------- motion

    setDown(down) {
        if (down && this.reveal.target === 0) {
            // every item swings a little as the line drops and stops
            for (const card of this.cards.values())
                card.swing.v += (Math.random() - 0.5) * (this._settings.get_boolean('sway') ? 1.4 : 0);
            this._bob.v += 30;
        }
        this.reveal.target = down ? 1 : 0;
        if (!down)
            this.setHovered(null);
        this._wake();
    }

    get isDown() {
        return this.reveal.target === 1;
    }

    get isHidden() {
        return this.reveal.target === 0 && this.reveal.value <= 0.001;
    }

    setFilter(ids) {
        this._filter = ids;
        this.scroll.target = 0;
        this._relayout();
    }

    flash(item) {
        const card = this.cards.get(item.id);
        if (!card)
            return;
        card.flash = 1.0;
        card.zoom.v += 2.6;
        if (this._settings.get_boolean('sway'))
            card.swing.v += 0.9;
        this._wake();
    }

    setHovered(card) {
        if (this.hovered === card)
            return;
        if (this.hovered) {
            this.hovered.zoom.target = 1;
            this.hovered.hover.target = 0;
        }
        this.hovered = card;
        if (card) {
            card.zoom.target = this._settings.get_boolean('zoom-on-hover') ? 1.28 : 1.0;
            card.hover.target = 1;
        }
        this._wake();
    }

    _wake() {
        if (this._tick)
            return;
        this._last = 0;
        this._tick = this.add_tick_callback((_w, clock) => this._step(clock));
    }

    _step(clock) {
        const now = clock.get_frame_time();
        const dt = this._last ? Math.min(1 / 30, (now - this._last) / 1e6) : 1 / 60;
        this._last = now;
        const sway = this._settings.get_boolean('sway');

        this.reveal.step(dt);
        this.scroll.step(dt);
        this._bob.step(dt);
        let busy = !this.reveal.settled || !this.scroll.settled || !this._bob.settled;

        for (const card of this.cards.values()) {
            const before = card.x.value;
            card.x.step(dt);
            // sliding along the line tilts the card back, like a real one would
            if (sway)
                card.swing.v -= Math.max(-0.05, Math.min(0.05, (card.x.value - before) * 0.004));
            else
                card.swing.snap(0);
            card.swing.step(dt);
            if (!card.falling)
                card.swing.value = Math.max(-0.45, Math.min(0.45, card.swing.value));
            card.zoom.step(dt);
            card.drop.step(dt);
            card.alpha.step(dt);
            card.hover.step(dt);
            if (card.flash > 0)
                card.flash = Math.max(0, card.flash - dt);
            busy ||= !card.settled;
        }
        for (const card of this._dying) {
            const f = card.falling;
            f.vy += 2600 * dt;
            f.y += f.vy * dt;
            card.swing.value += f.spin * dt;
            card.alpha.target = 0;
            card.alpha.step(dt);
        }
        const H = this.get_height();
        this._dying = this._dying.filter(c => c.falling.y < H + 40 && c.alpha.value > 0.02);
        busy ||= this._dying.length > 0;

        if (this._pointer)
            this._updateHover();
        this.queue_draw();
        this.onFrame?.();
        if (!busy) {
            this._tick = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    // ------------------------------------------------------------- input

    _controllers() {
        const motion = new Gtk.EventControllerMotion();
        motion.connect('enter', (_c, x, y) => {
            this._pointer = [x, y];
            this.onPointer?.(true);
            this._updateHover();
        });
        motion.connect('motion', (_c, x, y) => {
            const vx = this._pointer ? x - this._pointer[0] : 0;
            this._pointer = [x, y];
            this._pointerV = vx;
            this._updateHover(vx);
        });
        motion.connect('leave', () => {
            this._pointer = null;
            this.setHovered(null);
            this.onPointer?.(false);
        });
        this.add_controller(motion);

        const scroll = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.BOTH_AXES | Gtk.EventControllerScrollFlags.KINETIC,
        });
        scroll.connect('scroll', (c, dx, dy) => {
            const unit = c.get_unit?.() === Gdk.ScrollUnit.SURFACE ? 1 : 60;
            const W = this.get_width();
            const max = Math.max(0, this.contentWidth - W);
            this.scroll.target = Math.min(max, Math.max(0, this.scroll.target + (dx + dy) * unit));
            this._wake();
            return true;
        });
        this.add_controller(scroll);

        // Click copies, double-click opens, Shift-click is Quick Look, middle-click lets go,
        // right-click is the menu. Press and hold opens Markup.
        const click = new Gtk.GestureClick({button: 0});
        click.connect('pressed', (g, n, x, y) => {
            this.grab_focus();
            this._held = false;
            const hit = this._hit(x, y);
            const button = g.get_current_button();
            this._pressHit = hit;
            if (!hit)
                return;
            if (button === Gdk.BUTTON_PRIMARY && n === 2 && !hit.cross)
                this.onAction?.('open', hit.card.item);
            else if (button === Gdk.BUTTON_SECONDARY)
                this.onAction?.('menu', hit.card.item, this.cardRect(hit.card.item));
            else if (button === Gdk.BUTTON_MIDDLE)
                this.onAction?.('letgo', hit.card.item);
        });
        click.connect('released', (g, n, x, y) => {
            const hit = this._hit(x, y);
            const press = this._pressHit;
            this._pressHit = null;
            if (g.get_current_button() !== Gdk.BUTTON_PRIMARY || this._held || this._dragging || n !== 1)
                return;
            if (!hit || !press || hit.card !== press.card)
                return;
            if (hit.cross)
                this.onAction?.('letgo', hit.card.item);
            else if (g.get_current_event_state() & Gdk.ModifierType.SHIFT_MASK)
                this.onAction?.('quicklook', hit.card.item);
            else
                this.onAction?.('copy', hit.card.item);
        });
        this.add_controller(click);

        const hold = new Gtk.GestureLongPress({delay_factor: 1.0});
        hold.connect('pressed', (_g, x, y) => {
            const hit = this._hit(x, y);
            if (!hit || hit.cross)
                return;
            this._held = true;
            hit.card.zoom.v -= 2;
            this._wake();
            this.onAction?.('markup', hit.card.item);
        });
        this.add_controller(hold);

        const drag = new Gtk.DragSource({actions: Gdk.DragAction.COPY});
        drag.connect('prepare', (_s, x, y) => {
            const hit = this._hit(x, y);
            if (!hit || hit.cross)
                return null;
            this._dragCard = hit.card;
            return this.contentFor?.(hit.card.item) ?? null;
        });
        drag.connect('drag-begin', (source, _drag) => {
            const card = this._dragCard;
            if (!card)
                return;
            this._dragging = true;
            hold.reset();
            const [icon, hx, hy] = this._dragIcon(card);
            if (icon)
                source.set_icon(icon, hx, hy);
            card.alpha.target = 0.35;
            this._wake();
            this.onDrag?.(true, card.item);
        });
        drag.connect('drag-end', () => {
            const card = this._dragCard;
            this._dragging = false;
            this._dragCard = null;
            if (card)
                card.alpha.target = this._visible(card) ? 1 : 0;
            this._wake();
            this.onDrag?.(false, card?.item ?? null);
        });
        this.add_controller(drag);
    }

    _updateHover(vx = 0) {
        if (!this._pointer || this.reveal.value < 0.6) {
            this.setHovered(null);
            this.set_cursor_from_name(null);
            return;
        }
        const hit = this._hit(...this._pointer);
        this.setHovered(hit?.card ?? null);
        this.set_cursor_from_name(hit ? 'pointer' : null);
        if (hit && vx && this._settings.get_boolean('sway')) {
            hit.card.swing.v += Math.max(-0.6, Math.min(0.6, vx * 0.012));
            this._wake();
        }
    }

    /** The card drawn flat, as a picture to drag around. */
    _dragIcon(card) {
        try {
            const snap = new Gtk.Snapshot();
            this._drawCard(snap, card, true);
            const node = snap.to_node();
            if (!node)
                return [null, 0, 0];
            const renderer = this.get_native().get_renderer();
            const pad = 24;
            const bounds = rect(-card.w / 2 - pad, -pad, card.w + pad * 2, card.h + 6 + pad * 2);
            const texture = renderer.render_texture(node, bounds);
            return [texture, card.w / 2 + pad, pad + 10];
        } catch (e) {
            console.warn(`Festoon: no drag icon: ${e.message}`);
            return [null, 0, 0];
        }
    }

    // ------------------------------------------------------------- drawing

    _loadPin() {
        try {
            const path = GLib.build_filenamev([this._dir, 'assets', 'pin.svg']);
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 40, 104);
            this._pin = Gdk.Texture.new_for_pixbuf(pixbuf);
        } catch (e) {
            console.warn(`Festoon: no clip picture: ${e.message}`);
        }
    }

    vfunc_size_allocate(width, height, baseline) {
        super.vfunc_size_allocate(width, height, baseline);
        this._relayout();
    }

    vfunc_snapshot(s) {
        const W = this.get_width();
        // GTK sends nothing to the compositor for a frame with nothing in it, and a window that
        // has never had a frame is never shown: keep one invisible pixel.
        s.append_color(rgba(0, 0, 0, 0.004), rect(0, 0, 1, 1));
        if (this.reveal.value <= 0.001 && !this._dying.length)
            return;
        this._drawRope(s, W);
        if (!this.cards.size && this.reveal.value > 0.02)
            this._drawEmpty(s, W);
        for (const card of this._drawOrder()) {
            if (card.alpha.value <= 0.01)
                continue;
            const [cx, cy] = this._clipPoint(card);
            if (cx + card.w < -40 || cx - card.w > W + 40)
                continue;
            this._place(s, card, cx, cy);
        }
        for (const card of this._dying) {
            const [cx, cy] = this._clipPoint(card);
            this._place(s, card, cx, cy + card.falling.y);
        }
    }

    _place(s, card, cx, cy) {
        s.save();
        s.translate(point(cx, cy));
        s.rotate(card.swing.value * 180 / Math.PI);
        s.scale(card.zoom.value, card.zoom.value);
        const a = Math.max(0, Math.min(1, card.alpha.value));
        if (a < 0.999)
            s.push_opacity(a);
        this._drawCard(s, card, false);
        if (a < 0.999)
            s.pop();
        s.restore();
    }

    _drawRope(s, W) {
        const y0 = this.lineY;
        const H = this._ropeY(W / 2) + 8;
        if (y0 + H < 0)
            return;
        const cr = s.append_cairo(rect(0, Math.max(0, y0 - 4), W, H + 12));
        const path = () => {
            cr.moveTo(-10, this._ropeY(0) + y0);
            const n = 48;
            for (let i = 1; i <= n; i++) {
                const x = W * i / n;
                cr.lineTo(x, this._ropeY(x) + y0);
            }
            cr.lineTo(W + 10, this._ropeY(W) + y0);
        };
        cr.setLineCap(1);
        // shadow, cord, and the twist of the fibres
        cr.save();
        cr.translate(0, 3);
        path();
        cr.setSourceRGBA(0, 0, 0, 0.22);
        cr.setLineWidth(3.2);
        cr.stroke();
        cr.restore();
        path();
        cr.setSourceRGB(0.93, 0.90, 0.84);
        cr.setLineWidth(2.6);
        cr.stroke();
        path();
        cr.setSourceRGBA(0.55, 0.50, 0.43, 0.7);
        cr.setLineWidth(1.0);
        cr.setDash([2.2, 3.4], 0);
        cr.stroke();
        cr.$dispose();
    }

    _drawEmpty(s, W) {
        const text = this.message || 'Screenshots and the things you copy hang here.';
        const layout = this._text(text, 0.92, Pango.Weight.MEDIUM);
        const [, logical] = layout.get_pixel_extents();
        const w = logical.width + 26;
        const h = logical.height + 14;
        const x = W / 2 - w / 2;
        const y = this._ropeY(W / 2) + this.lineY + 12;
        s.append_outset_shadow(rounded(x, y, w, h, h / 2), SHADOW, 0, 3, 0, 10);
        s.push_rounded_clip(rounded(x, y, w, h, h / 2));
        s.append_color(rgba(27, 26, 23, 0.92), rect(x, y, w, h));
        s.pop();
        s.save();
        s.translate(point(x + 13, y + 7));
        s.append_layout(layout, rgba(244, 237, 224));
        s.restore();
    }

    _text(text, scale, weight = Pango.Weight.NORMAL, family = null) {
        const layout = this.create_pango_layout(text);
        const desc = this.get_pango_context().get_font_description().copy();
        desc.set_size(Math.round(desc.get_size() * scale));
        desc.set_weight(weight);
        if (family)
            desc.set_family(family);
        layout.set_font_description(desc);
        return layout;
    }

    /** Draw a card hanging from (0, 0): the clip at the origin, the card below it. */
    _drawCard(s, card, flat) {
        const {w, h} = card;
        const x = -w / 2;
        const y = 6;
        const item = card.item;

        s.append_outset_shadow(rounded(x, y, w, h, 10), SHADOW, 0, 6, 0, 16);

        switch (item.kind) {
        case 'note':
            this._drawNote(s, card, x, y, w, h);
            break;
        case 'link':
            this._drawLink(s, card, x, y, w, h);
            break;
        case 'recording':
            this._drawRecording(s, card, x, y, w, h);
            break;
        default:
            this._drawPicture(s, card, x, y, w, h);
        }

        // the clip, gripping the top of the card and the cord
        if (this._pin) {
            const pw = Math.round(this.size * 0.12 + 3);
            const ph = Math.round(pw * 2.6);
            s.append_texture(this._pin, rect(-pw / 2, -ph * 0.42, pw, ph));
        }

        if (flat)
            return;

        // the cross, and what the item is
        const t = card.hover.value;
        if (t > 0.02) {
            s.push_opacity(Math.min(1, t));
            const bx = w / 2 - 3;
            const by = y + 3;
            s.append_outset_shadow(rounded(bx - 10, by - 10, 20, 20, 10), SHADOW, 0, 1, 0, 4);
            s.push_rounded_clip(rounded(bx - 10, by - 10, 20, 20, 10));
            s.append_color(rgba(27, 26, 23, 0.9), rect(bx - 10, by - 10, 20, 20));
            s.pop();
            const cr = s.append_cairo(rect(bx - 6, by - 6, 12, 12));
            cr.setSourceRGB(1, 1, 1);
            cr.setLineWidth(1.6);
            cr.setLineCap(1);
            cr.moveTo(bx - 3.5, by - 3.5);
            cr.lineTo(bx + 3.5, by + 3.5);
            cr.moveTo(bx + 3.5, by - 3.5);
            cr.lineTo(bx - 3.5, by + 3.5);
            cr.stroke();
            cr.$dispose();

            const caption = this._caption(card);
            const layout = this._text(caption, 0.78, Pango.Weight.MEDIUM);
            const [, logical] = layout.get_pixel_extents();
            const cw = logical.width + 16;
            const ch = logical.height + 6;
            const cy = y + h + 8;
            s.push_rounded_clip(rounded(-cw / 2, cy, cw, ch, ch / 2));
            s.append_color(rgba(27, 26, 23, 0.88), rect(-cw / 2, cy, cw, ch));
            s.pop();
            s.save();
            s.translate(point(-cw / 2 + 8, cy + 3));
            s.append_layout(layout, rgba(244, 237, 224));
            s.restore();
            s.pop();
        }

        if (card.flash > 0) {
            const a = Math.min(1, card.flash * 3);
            s.push_opacity(a);
            const layout = this._text('Copied', 0.9, Pango.Weight.BOLD);
            const [, logical] = layout.get_pixel_extents();
            const fw = logical.width + 22;
            const fh = logical.height + 10;
            const fy = y + h / 2 - fh / 2;
            s.push_rounded_clip(rounded(-fw / 2, fy, fw, fh, fh / 2));
            s.append_color(rgba(27, 26, 23, 0.9), rect(-fw / 2, fy, fw, fh));
            s.pop();
            s.save();
            s.translate(point(-fw / 2 + 11, fy + 5));
            s.append_layout(layout, WHITE);
            s.restore();
            s.pop();
        }
    }

    _caption(card) {
        const item = card.item;
        const name = KIND_NAMES[item.kind] ?? 'Item';
        if (item.kind === 'recording' && card.duration)
            return `${name} · ${duration(card.duration)}`;
        if (item.kind === 'link')
            return `${name} · ${ago(item.created)}`;
        return `${name} · ${ago(item.created)}`;
    }

    /** Screenshots and images: a glass frame around the picture. */
    _drawPicture(s, card, x, y, w, h) {
        s.push_rounded_clip(rounded(x, y, w, h, 10));
        s.append_color(rgba(250, 250, 252, 0.62), rect(x, y, w, h));
        s.pop();
        const p = 4;
        const inner = rounded(x + p, y + p, w - p * 2, h - p * 2, 6.5);
        s.push_rounded_clip(inner);
        if (card.texture) {
            // cover the frame, keeping the picture's proportions
            const fw = w - p * 2;
            const fh = h - p * 2;
            let tw = fw;
            let th = fw / card.aspect;
            if (th < fh) {
                th = fh;
                tw = fh * card.aspect;
            }
            s.append_scaled_texture(card.texture, Gsk.ScalingFilter.TRILINEAR,
                rect(x + p + (fw - tw) / 2, y + p + (fh - th) / 2, tw, th));
        } else {
            s.append_color(rgba(220, 216, 208), rect(x + p, y + p, w - p * 2, h - p * 2));
        }
        s.pop();
        s.append_border(rounded(x, y, w, h, 10), [1, 1, 1, 1],
            [rgba(255, 255, 255, 0.8), rgba(255, 255, 255, 0.5), rgba(0, 0, 0, 0.12), rgba(255, 255, 255, 0.5)]);
    }

    _drawRecording(s, card, x, y, w, h) {
        s.push_rounded_clip(rounded(x, y, w, h, 10));
        s.append_color(rgba(27, 26, 23), rect(x, y, w, h));
        const p = 4;
        if (card.paintable) {
            s.save();
            s.translate(point(x + p, y + p));
            s.push_rounded_clip(rounded(0, 0, w - p * 2, h - p * 2, 6.5));
            card.paintable.snapshot(s, w - p * 2, h - p * 2);
            s.pop();
            s.restore();
        }
        s.pop();
        // play badge
        const r = Math.min(w, h) * 0.16;
        s.push_rounded_clip(rounded(-r, y + h / 2 - r, r * 2, r * 2, r));
        s.append_color(rgba(0, 0, 0, 0.5), rect(-r, y + h / 2 - r, r * 2, r * 2));
        s.pop();
        const cr = s.append_cairo(rect(-r, y + h / 2 - r, r * 2, r * 2));
        cr.setSourceRGB(1, 1, 1);
        cr.moveTo(-r * 0.32, y + h / 2 - r * 0.45);
        cr.lineTo(r * 0.5, y + h / 2);
        cr.lineTo(-r * 0.32, y + h / 2 + r * 0.45);
        cr.closePath();
        cr.fill();
        cr.$dispose();
        if (card.duration) {
            const layout = this._text(duration(card.duration), 0.72, Pango.Weight.BOLD);
            const [, logical] = layout.get_pixel_extents();
            const dw = logical.width + 10;
            const dh = logical.height + 4;
            s.push_rounded_clip(rounded(x + w - dw - 8, y + h - dh - 8, dw, dh, 5));
            s.append_color(rgba(0, 0, 0, 0.6), rect(x + w - dw - 8, y + h - dh - 8, dw, dh));
            s.pop();
            s.save();
            s.translate(point(x + w - dw - 3, y + h - dh - 6));
            s.append_layout(layout, WHITE);
            s.restore();
        }
        s.append_border(rounded(x, y, w, h, 10), [1, 1, 1, 1],
            [rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.2), rgba(0, 0, 0, 0.2), rgba(255, 255, 255, 0.2)]);
    }

    /** Text: a sheet of paper with the first line as its title. */
    _drawNote(s, card, x, y, w, h) {
        const S = this.size;
        s.push_rounded_clip(rounded(x, y, w, h, 7));
        s.append_color(PAPER, rect(x, y, w, h));
        s.append_color(rgba(245, 197, 66), rect(x, y, w, 4));
        // faint ruling
        for (let ly = y + S * 0.42; ly < y + h - 6; ly += S * 0.13)
            s.append_color(rgba(120, 100, 40, 0.07), rect(x + 8, ly, w - 16, 1));
        s.pop();

        if (!card.layouts) {
            const item = card.item;
            const pad = Math.round(S * 0.08);
            const title = this._text(item.title || 'Note', S / 124 * 0.92, Pango.Weight.BOLD);
            title.set_width((w - pad * 2) * Pango.SCALE);
            title.set_ellipsize(Pango.EllipsizeMode.END);
            title.set_height(-2);
            title.set_wrap(Pango.WrapMode.WORD_CHAR);
            const lines = item.text.split('\n');
            const firstIdx = lines.findIndex(l => l.trim());
            const rest = lines.slice(firstIdx + 1).join('\n').trim();
            const body = this._text(rest || ' ', S / 124 * 0.74);
            body.set_width((w - pad * 2) * Pango.SCALE);
            body.set_wrap(Pango.WrapMode.WORD_CHAR);
            body.set_ellipsize(Pango.EllipsizeMode.END);
            card.layouts = {title, body, pad};
        }
        const {title, body, pad} = card.layouts;
        const [, tl] = title.get_pixel_extents();
        body.set_height((h - pad * 2 - tl.height - 4) * Pango.SCALE);
        s.save();
        s.translate(point(x + pad, y + pad + 2));
        s.append_layout(title, INK);
        s.translate(point(0, tl.height + 3));
        s.append_layout(body, DIM);
        s.restore();
        s.append_border(rounded(x, y, w, h, 7), [1, 1, 1, 1],
            [rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.06)]);
    }

    /** A web address: the site, big, and the path under it. */
    _drawLink(s, card, x, y, w, h) {
        const S = this.size;
        s.push_rounded_clip(rounded(x, y, w, h, 10));
        s.append_color(WHITE, rect(x, y, w, h));
        s.pop();
        const {site, path} = linkParts(card.item.url);
        const d = h * 0.46;
        const cx = x + h * 0.5 - d / 2 + 2;
        const cy = y + h / 2 - d / 2;
        s.push_rounded_clip(rounded(cx, cy, d, d, d / 2));
        s.append_color(hsl(hashHue(site), 0.62, 0.52), rect(cx, cy, d, d));
        s.pop();
        if (!card.layouts) {
            const letter = this._text((site[0] ?? '?').toUpperCase(), S / 124 * 1.05, Pango.Weight.HEAVY);
            const textX = cx + d + 10;
            const room = (x + w - 12 - textX) * Pango.SCALE;
            const siteL = this._text(site, S / 124 * 0.9, Pango.Weight.BOLD);
            siteL.set_width(room);
            siteL.set_ellipsize(Pango.EllipsizeMode.END);
            const pathL = this._text(path || '/', S / 124 * 0.72);
            pathL.set_width(room);
            pathL.set_ellipsize(Pango.EllipsizeMode.MIDDLE);
            card.layouts = {letter, siteL, pathL, textX};
        }
        const {letter, siteL, pathL, textX} = card.layouts;
        const [, ll] = letter.get_pixel_extents();
        s.save();
        s.translate(point(cx + d / 2 - ll.width / 2 - ll.x, cy + d / 2 - ll.height / 2 - ll.y));
        s.append_layout(letter, WHITE);
        s.restore();
        const [, sl] = siteL.get_pixel_extents();
        const [, pl] = pathL.get_pixel_extents();
        const top = y + h / 2 - (sl.height + pl.height + 2) / 2;
        s.save();
        s.translate(point(textX, top));
        s.append_layout(siteL, INK);
        s.translate(point(0, sl.height + 2));
        s.append_layout(pathL, DIM);
        s.restore();
        s.append_border(rounded(x, y, w, h, 10), [1, 1, 1, 1],
            [rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.06), rgba(0, 0, 0, 0.14), rgba(0, 0, 0, 0.06)]);
    }

    destroy() {
        if (this._tick)
            this.remove_tick_callback(this._tick);
        this._tick = 0;
        for (const card of this.cards.values())
            card.media?.set_playing(false);
    }
});
