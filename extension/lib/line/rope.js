// The cord the items hang from, in a few styles. Drawn with cairo at the screen's own scale, so
// it stays sharp on HiDPI screens: a soft shadow, the body of the cord with darker edges, the
// twist of its strands, and a highlight along the top.

export const ROPES = [
    ['cotton', 'Cotton, wooden pegs'],
    ['jute', 'Jute, wooden pegs'],
    ['twine', 'Baker’s twine, candy-striped pegs'],
    ['wire', 'Steel wire, binder clips'],
    ['lights', 'Fairy lights, wooden pegs'],
    ['licorice', 'Licorice, gummy bears'],
    ['spaghetti', 'Spaghetti, meatballs'],
    ['bunting', 'Party bunting, rainbow pegs'],
    ['paperclips', 'Paperclip chain, binder clips'],
    ['dna', 'Double helix, lab-coloured pegs'],
];

/** Which clip holds the items on each line. */
export const CLIP_FOR = {
    cotton: 'wood', jute: 'wood', lights: 'wood', twine: 'candy', wire: 'binder',
    licorice: 'gummy', spaghetti: 'meatball', bunting: 'rainbow', paperclips: 'binder', dna: 'lab',
};

const STYLES = {
    cotton: {width: 3.4, edge: [0.62, 0.57, 0.48], body: [0.95, 0.92, 0.86], twist: [[0.74, 0.69, 0.60]], shine: 0.55},
    jute: {width: 4.0, edge: [0.38, 0.26, 0.13], body: [0.74, 0.56, 0.33], twist: [[0.52, 0.37, 0.19]], shine: 0.30, fuzz: true},
    twine: {width: 3.0, edge: [0.62, 0.58, 0.55], body: [0.98, 0.97, 0.95], twist: [[0.84, 0.20, 0.17], [0.98, 0.97, 0.95]], shine: 0.5},
    wire: {width: 2.2, edge: [0.25, 0.27, 0.30], body: [0.78, 0.80, 0.84], shine: 0.9},
    lights: {width: 1.6, edge: [0.08, 0.14, 0.09], body: [0.16, 0.27, 0.17], shine: 0.25, bulbs: true},
    licorice: {width: 6.0, edge: [0.42, 0.02, 0.05], body: [0.80, 0.07, 0.14], twist: [[0.55, 0.03, 0.08]], shine: 0.75},
    bunting: {width: 1.4, edge: [0.35, 0.30, 0.26], body: [0.92, 0.88, 0.80], shine: 0.3, flags: true},
};

const RAINBOW = [[0.93, 0.27, 0.23], [0.98, 0.62, 0.15], [0.98, 0.84, 0.22], [0.30, 0.72, 0.36], [0.18, 0.55, 0.92], [0.55, 0.36, 0.86]];

const BULBS = [[1.0, 0.78, 0.36], [1.0, 0.45, 0.38], [0.48, 0.80, 1.0], [0.62, 0.95, 0.55], [0.98, 0.62, 0.95]];

/** Points every few pixels along the curve, with their tangent and normal. */
function sample(curve, x0, x1, step = 3) {
    const pts = [];
    for (let x = x0; x <= x1 + step; x += step) {
        const y = curve(x);
        const dy = (curve(x + 1) - curve(x - 1)) / 2;
        const len = Math.hypot(1, dy);
        pts.push({x, y, tx: 1 / len, ty: dy / len, nx: -dy / len, ny: 1 / len});
    }
    return pts;
}

function stroke(cr, pts, dy, width, rgba) {
    cr.moveTo(pts[0].x, pts[0].y + dy);
    for (let i = 1; i < pts.length; i++)
        cr.lineTo(pts[i].x, pts[i].y + dy);
    cr.setSourceRGBA(...rgba);
    cr.setLineWidth(width);
    cr.stroke();
}

/**
 * Draw the cord along y = curve(x) from x0 to x1.
 * `glow` (0..1) lights the fairy lights.
 */
export function drawRope(cr, curve, x0, x1, style = 'cotton', glow = 1) {
    const custom = {spaghetti: drawSpaghetti, paperclips: drawPaperclips, dna: drawHelix}[style];
    if (custom) {
        cr.setLineCap(1);
        cr.setLineJoin(1);
        custom(cr, curve, x0, x1);
        return;
    }
    const s = STYLES[style] ?? STYLES.cotton;
    const pts = sample(curve, x0, x1);
    const w = s.width;
    cr.setLineCap(1);
    cr.setLineJoin(1);

    // a soft shadow on whatever is underneath
    stroke(cr, pts, 3.2, w + 4, [0, 0, 0, 0.08]);
    stroke(cr, pts, 2.6, w + 1.6, [0, 0, 0, 0.14]);
    stroke(cr, pts, 2.0, w, [0, 0, 0, 0.16]);

    // the cord: darker edges, lighter body
    stroke(cr, pts, 0, w + 1.2, [...s.edge, 1]);
    stroke(cr, pts, 0, w - 0.4, [...s.body, 1]);

    // the twist of the strands: short diagonal strokes across the cord
    if (s.twist) {
        const r = w / 2;
        cr.setLineWidth(Math.max(0.7, w * 0.26));
        let n = 0;
        let dist = 0;
        for (let i = 1; i < pts.length; i++) {
            const p = pts[i];
            dist += 3;
            if (dist < w * 1.15)
                continue;
            dist = 0;
            const color = s.twist[n++ % s.twist.length];
            cr.setSourceRGBA(...color, 0.9);
            const k = r * 0.95;
            cr.moveTo(p.x - p.tx * k + p.nx * -k, p.y - p.ty * k + p.ny * -k);
            cr.lineTo(p.x + p.tx * k + p.nx * k, p.y + p.ty * k + p.ny * k);
            cr.stroke();
        }
    }
    if (s.fuzz) {
        // stray fibres
        cr.setLineWidth(0.5);
        cr.setSourceRGBA(...s.edge, 0.55);
        for (let i = 5; i < pts.length; i += 7) {
            const p = pts[i];
            const side = (i * 7919) % 3 === 0 ? -1 : 1;
            const len = 1.8 + ((i * 104729) % 5) * 0.5;
            cr.moveTo(p.x + p.nx * side * w * 0.45, p.y + p.ny * side * w * 0.45);
            cr.lineTo(p.x + p.nx * side * (w * 0.45 + len) + p.tx * len * 0.6, p.y + p.ny * side * (w * 0.45 + len));
            cr.stroke();
        }
    }

    // light catching the top of the cord
    stroke(cr, pts, -w * 0.22, Math.max(0.6, w * 0.22), [1, 1, 1, s.shine * 0.6]);

    if (s.bulbs)
        drawBulbs(cr, pts, glow);
    if (s.flags)
        drawFlags(cr, pts);
}

function drawFlags(cr, pts) {
    for (let i = 4, n = 0; i + 10 < pts.length; i += 14, n++) {
        const a = pts[i];
        const b = pts[i + 10];
        const [r, g, bl] = RAINBOW[n % RAINBOW.length];
        const mx = (a.x + b.x) / 2;
        const tip = Math.max(a.y, b.y) + 22;
        cr.moveTo(a.x, a.y + 1);
        cr.lineTo(b.x, b.y + 1);
        cr.lineTo(mx, tip);
        cr.closePath();
        cr.setSourceRGBA(0, 0, 0, 0.18);
        cr.save();
        cr.translate(1.5, 2.5);
        cr.fillPreserve();
        cr.restore();
        cr.setSourceRGB(r, g, bl);
        cr.fill();
        // a little dot pattern on every other flag
        if (n % 2) {
            cr.setSourceRGBA(1, 1, 1, 0.55);
            for (const [dx, dy] of [[-5, 6], [4, 6], [0, 13]]) {
                cr.arc(mx + dx, a.y + dy, 1.3, 0, Math.PI * 2);
                cr.fill();
            }
        }
    }
}

/** Two cooked noodles, twisted around each other, with a basil leaf here and there. */
function drawSpaghetti(cr, curve, x0, x1) {
    const pts = sample(curve, x0, x1, 2);
    for (const [phase, amp, dy] of [[0, 2.2, 0], [Math.PI, 2.0, 0.8]]) {
        const p = pts.map(q => ({...q, y: q.y + dy + Math.sin(q.x * 0.045 + phase) * amp + Math.sin(q.x * 0.013 + phase) * 1.5}));
        stroke(cr, p, 2.6, 4.4, [0, 0, 0, 0.14]);
        stroke(cr, p, 0, 4.2, [0.78, 0.60, 0.25, 1]);
        stroke(cr, p, 0, 3.0, [0.97, 0.84, 0.48, 1]);
        stroke(cr, p, -0.8, 0.9, [1, 0.97, 0.85, 0.8]);
    }
    for (let i = 30; i < pts.length; i += 90) {
        const p = pts[i];
        cr.save();
        cr.translate(p.x, p.y - 1);
        cr.rotate(-0.6 + (i % 3) * 0.4);
        cr.scale(1, 0.5);
        cr.arc(0, 0, 5, 0, Math.PI * 2);
        cr.restore();
        cr.setSourceRGB(0.24, 0.58, 0.22);
        cr.fill();
        // a drop of sauce
        cr.arc(p.x + 14, p.y + 2, 1.8, 0, Math.PI * 2);
        cr.setSourceRGB(0.78, 0.15, 0.10);
        cr.fill();
    }
}

/** Paperclips hooked into each other, silver and coloured. */
function drawPaperclips(cr, curve, x0, x1) {
    const pts = sample(curve, x0, x1, 3);
    const colors = [[0.75, 0.77, 0.80], [0.93, 0.27, 0.23], [0.75, 0.77, 0.80], [0.18, 0.55, 0.92], [0.75, 0.77, 0.80], [0.98, 0.78, 0.15]];
    for (let i = 0, n = 0; i < pts.length; i += 6, n++) {
        const p = pts[i];
        const [r, g, b] = colors[n % colors.length];
        cr.save();
        cr.translate(p.x, p.y);
        cr.rotate(Math.atan2(p.ty, p.tx));
        const loop = (w, h) => {
            cr.newSubPath();
            cr.arc(w / 2 - h / 2, 0, h / 2, -Math.PI / 2, Math.PI / 2);
            cr.arc(-w / 2 + h / 2, 0, h / 2, Math.PI / 2, 1.5 * Math.PI);
            cr.closePath();
        };
        cr.setLineWidth(1.6);
        cr.save();
        cr.translate(0.8, 2.2);
        loop(26, 9);
        cr.setSourceRGBA(0, 0, 0, 0.16);
        cr.stroke();
        cr.restore();
        loop(26, 9);
        cr.setSourceRGB(r * 0.7, g * 0.7, b * 0.7);
        cr.setLineWidth(2.0);
        cr.strokePreserve();
        cr.setSourceRGB(r, g, b);
        cr.setLineWidth(1.2);
        cr.stroke();
        // the inner turn of the wire
        cr.moveTo(-6, -2);
        cr.lineTo(7, -2);
        cr.arc(7, 0, 2, -Math.PI / 2, Math.PI / 2);
        cr.lineTo(-3, 2);
        cr.setSourceRGB(r, g, b);
        cr.stroke();
        cr.restore();
    }
}

/** A double helix: two strands winding round each other, with base pairs between them. */
function drawHelix(cr, curve, x0, x1) {
    const pts = sample(curve, x0, x1, 2);
    const amp = 6;
    const k = 0.075;
    const pairs = [[0.93, 0.27, 0.23], [0.30, 0.72, 0.36], [0.98, 0.70, 0.15], [0.18, 0.55, 0.92]];
    // base pairs first, behind the strands
    for (let i = 0, n = 0; i < pts.length; i += 3, n++) {
        const p = pts[i];
        const a = p.y + Math.sin(p.x * k) * amp;
        const b = p.y - Math.sin(p.x * k) * amp;
        if (Math.abs(a - b) < 3)
            continue;
        const [r, g, bl] = pairs[n % pairs.length];
        const [r2, g2, bl2] = pairs[(n + 2) % pairs.length];
        const m = (a + b) / 2;
        cr.setLineWidth(1.8);
        cr.moveTo(p.x, a);
        cr.lineTo(p.x, m);
        cr.setSourceRGBA(r, g, bl, 0.9);
        cr.stroke();
        cr.moveTo(p.x, m);
        cr.lineTo(p.x, b);
        cr.setSourceRGBA(r2, g2, bl2, 0.9);
        cr.stroke();
    }
    for (const [sign, color, edge] of [[1, [0.36, 0.55, 0.98], [0.16, 0.30, 0.70]], [-1, [0.98, 0.55, 0.30], [0.70, 0.30, 0.12]]]) {
        const strand = pts.map(q => ({...q, y: q.y + sign * Math.sin(q.x * k) * amp}));
        stroke(cr, strand, 2.4, 3.4, [0, 0, 0, 0.14]);
        stroke(cr, strand, 0, 3.6, [...edge, 1]);
        stroke(cr, strand, 0, 2.4, [...color, 1]);
        stroke(cr, strand, -0.6, 0.8, [1, 1, 1, 0.5]);
    }
}

// ------------------------------------------------------------ clips

function roundRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/** A plastic peg in one colour, or with stripes. */
function plasticPeg(cr, w, h, color, stripe = null) {
    const x = -w / 2;
    const y = -h * 0.42;
    roundRect(cr, x + 0.6, y + 1.6, w, h, w * 0.3);
    cr.setSourceRGBA(0, 0, 0, 0.25);
    cr.fill();
    roundRect(cr, x, y, w, h, w * 0.3);
    cr.setSourceRGB(...color.map(c => c * 0.72));
    cr.fillPreserve();
    cr.save();
    cr.clip();
    roundRect(cr, x + 0.9, y + 0.9, w - 1.8, h - 1.8, w * 0.25);
    cr.setSourceRGB(...color);
    cr.fill();
    if (stripe) {
        cr.setSourceRGB(...stripe);
        cr.setLineWidth(w * 0.28);
        for (let sy = y - w; sy < y + h + w; sy += w * 0.75) {
            cr.moveTo(x - 2, sy);
            cr.lineTo(x + w + 2, sy + w * 0.8);
            cr.stroke();
        }
    }
    // the split between the two jaws, and a shine
    cr.setSourceRGBA(0, 0, 0, 0.22);
    cr.rectangle(-0.5, y, 1, h);
    cr.fill();
    cr.setSourceRGBA(1, 1, 1, 0.45);
    cr.rectangle(x + w * 0.18, y + 2, w * 0.14, h - 4);
    cr.fill();
    cr.restore();
    // the spring
    roundRect(cr, x - w * 0.12, y + h * 0.38, w * 1.24, h * 0.09, h * 0.045);
    cr.setSourceRGB(0.78, 0.79, 0.77);
    cr.fillPreserve();
    cr.setSourceRGB(0.36, 0.37, 0.35);
    cr.setLineWidth(0.7);
    cr.stroke();
}

function binderClip(cr, w, h) {
    const bw = w * 1.7;
    const top = h * 0.06;       // the jaws bite the top of the card, the handles reach the cord
    const bh = h * 0.40;
    // the silver handles, folded up over the cord
    cr.setLineWidth(Math.max(1.2, w * 0.13));
    for (const side of [-1, 1]) {
        cr.moveTo(side * bw * 0.32, top + 2);
        cr.lineTo(side * bw * 0.24, -h * 0.30);
        cr.lineTo(-side * bw * 0.06, -h * 0.30);
    }
    cr.setSourceRGB(0.55, 0.57, 0.60);
    cr.stroke();
    // the black body
    cr.moveTo(-bw / 2, top + bh);
    cr.lineTo(-bw * 0.38, top);
    cr.lineTo(bw * 0.38, top);
    cr.lineTo(bw / 2, top + bh);
    cr.closePath();
    cr.setSourceRGBA(0, 0, 0, 0.25);
    cr.save();
    cr.translate(0.6, 1.6);
    cr.fillPreserve();
    cr.restore();
    cr.setSourceRGB(0.09, 0.09, 0.10);
    cr.fill();
    cr.setSourceRGBA(1, 1, 1, 0.18);
    cr.rectangle(-bw * 0.33, top + 1.5, bw * 0.66, 1.2);
    cr.fill();
}

function gummyBear(cr, w, h, color) {
    const s = w / 9;
    const [r, g, b] = color;
    cr.save();
    cr.translate(0, -h * 0.18);
    cr.scale(s, s);
    const shape = () => {
        cr.newSubPath(); cr.arc(0, -6, 4.6, 0, Math.PI * 2);           // head
        cr.newSubPath(); cr.arc(-3.6, -9.6, 1.8, 0, Math.PI * 2);      // ears
        cr.newSubPath(); cr.arc(3.6, -9.6, 1.8, 0, Math.PI * 2);
        cr.save(); cr.translate(0, 3.5); cr.scale(1, 1.25); cr.newSubPath(); cr.arc(0, 0, 5, 0, Math.PI * 2); cr.restore();
        cr.newSubPath(); cr.arc(-5.2, 0.5, 2, 0, Math.PI * 2);         // arms, holding on
        cr.newSubPath(); cr.arc(5.2, 0.5, 2, 0, Math.PI * 2);
        cr.newSubPath(); cr.arc(-3.4, 9.6, 2.3, 0, Math.PI * 2);       // feet
        cr.newSubPath(); cr.arc(3.4, 9.6, 2.3, 0, Math.PI * 2);
    };
    cr.save();
    cr.translate(0.4, 1.0);
    shape();
    cr.setSourceRGBA(0, 0, 0, 0.22);
    cr.fill();
    cr.restore();
    shape();
    cr.setSourceRGBA(r, g, b, 0.92);
    cr.fillPreserve();
    cr.setSourceRGBA(r * 0.6, g * 0.6, b * 0.6, 0.9);
    cr.setLineWidth(0.5);
    cr.stroke();
    // shine, eyes and a smile
    cr.setSourceRGBA(1, 1, 1, 0.6);
    cr.save(); cr.translate(-2, -8); cr.scale(1, 0.6); cr.arc(0, 0, 1.4, 0, Math.PI * 2); cr.restore();
    cr.fill();
    cr.setSourceRGBA(r * 0.35, g * 0.35, b * 0.35, 0.9);
    cr.arc(-1.6, -6.2, 0.6, 0, Math.PI * 2);
    cr.fill();
    cr.arc(1.6, -6.2, 0.6, 0, Math.PI * 2);
    cr.fill();
    cr.setLineWidth(0.5);
    cr.arc(0, -4.8, 1.3, 0.3, Math.PI - 0.3);
    cr.stroke();
    cr.restore();
}

function meatball(cr, w) {
    const r = w * 0.62;
    const y = r * 0.55;         // sitting on the card, stuck to the noodle
    cr.arc(0.6, y + 1.8, r, 0, Math.PI * 2);
    cr.setSourceRGBA(0, 0, 0, 0.25);
    cr.fill();
    cr.arc(0, y, r, 0, Math.PI * 2);
    cr.setSourceRGB(0.42, 0.24, 0.13);
    cr.fill();
    // lumpy texture
    cr.setSourceRGBA(0.30, 0.16, 0.08, 0.7);
    for (const [dx, dy, rr] of [[-0.35, 0.2, 0.18], [0.3, 0.35, 0.15], [0.1, -0.3, 0.13], [-0.2, -0.45, 0.1]]) {
        cr.arc(dx * r, y + dy * r, rr * r, 0, Math.PI * 2);
        cr.fill();
    }
    // tomato sauce on top, dripping
    cr.moveTo(-r * 0.85, y - r * 0.3);
    cr.curveTo(-r * 0.6, y - r * 1.1, r * 0.6, y - r * 1.1, r * 0.85, y - r * 0.3);
    cr.curveTo(r * 0.6, y - r * 0.1, r * 0.45, y + r * 0.35, r * 0.3, y - r * 0.05);
    cr.curveTo(r * 0.1, y - r * 0.25, -r * 0.2, y + r * 0.5, -r * 0.35, y - r * 0.05);
    cr.curveTo(-r * 0.5, y - r * 0.3, -r * 0.7, y - r * 0.1, -r * 0.85, y - r * 0.3);
    cr.setSourceRGB(0.80, 0.14, 0.10);
    cr.fill();
    cr.arc(-r * 0.3, y - r * 0.55, r * 0.15, 0, Math.PI * 2);
    cr.setSourceRGBA(1, 1, 1, 0.5);
    cr.fill();
    // parsley
    cr.setSourceRGB(0.22, 0.55, 0.20);
    for (const [dx, dy] of [[0.15, -0.65], [0.45, -0.45], [-0.05, -0.85]]) {
        cr.rectangle(dx * r, y + dy * r, r * 0.16, r * 0.1);
        cr.fill();
    }
}

/**
 * Draw the clip for a line style, gripping the cord at (0, 0), `w` wide and `h` tall.
 * `n` picks a colour for the clips that come in several. Returns false for the wooden peg,
 * which is a picture drawn by the caller.
 */
export function drawClip(cr, style, w, h, n) {
    switch (CLIP_FOR[style] ?? 'wood') {
    case 'candy':
        plasticPeg(cr, w, h, [0.98, 0.97, 0.95], [0.84, 0.20, 0.17]);
        return true;
    case 'rainbow':
        plasticPeg(cr, w, h, RAINBOW[n % RAINBOW.length]);
        return true;
    case 'lab':
        plasticPeg(cr, w, h, [[0.36, 0.55, 0.98], [0.98, 0.55, 0.30], [0.30, 0.72, 0.36], [0.98, 0.78, 0.15]][n % 4]);
        return true;
    case 'binder':
        binderClip(cr, w, h);
        return true;
    case 'gummy':
        gummyBear(cr, w * 1.5, h, [[0.93, 0.18, 0.20], [0.98, 0.62, 0.10], [0.98, 0.86, 0.20], [0.30, 0.78, 0.30], [0.95, 0.95, 0.90]][n % 5]);
        return true;
    case 'meatball':
        meatball(cr, w * 1.2);
        return true;
    default:
        return false;
    }
}

function drawBulbs(cr, pts, glow) {
    const every = 22;       // samples: about 66 px
    for (let i = 8, n = 0; i < pts.length; i += every, n++) {
        const p = pts[i];
        const [r, g, b] = BULBS[n % BULBS.length];
        const bx = p.x;
        const by = p.y + 8.5;
        // glow
        if (glow > 0) {
            for (const [rad, a] of [[16, 0.10], [10, 0.16], [6, 0.24]]) {
                cr.arc(bx, by, rad, 0, Math.PI * 2);
                cr.setSourceRGBA(r, g, b, a * glow);
                cr.fill();
            }
        }
        // socket
        cr.setSourceRGB(0.10, 0.16, 0.10);
        cr.rectangle(bx - 2.2, p.y, 4.4, 4.5);
        cr.fill();
        // bulb
        cr.save();
        cr.translate(bx, by);
        cr.scale(1, 1.35);
        cr.arc(0, 0, 4.2, 0, Math.PI * 2);
        cr.restore();
        cr.setSourceRGB(r * 0.75 + 0.25 * glow, g * 0.75 + 0.25 * glow, b * 0.75 + 0.25 * glow);
        cr.fill();
        cr.arc(bx - 1.1, by - 1.6, 1.0, 0, Math.PI * 2);
        cr.setSourceRGBA(1, 1, 1, 0.85);
        cr.fill();
    }
}
