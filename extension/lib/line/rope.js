// The cord the items hang from, in a few styles. Drawn with cairo at the screen's own scale, so
// it stays sharp on HiDPI screens: a soft shadow, the body of the cord with darker edges, the
// twist of its strands, and a highlight along the top.

export const ROPES = [
    ['cotton', 'Cotton'],
    ['jute', 'Jute'],
    ['twine', 'Baker’s twine'],
    ['wire', 'Steel wire'],
    ['lights', 'Fairy lights'],
];

const STYLES = {
    cotton: {width: 3.4, edge: [0.62, 0.57, 0.48], body: [0.95, 0.92, 0.86], twist: [[0.74, 0.69, 0.60]], shine: 0.55},
    jute: {width: 4.0, edge: [0.38, 0.26, 0.13], body: [0.74, 0.56, 0.33], twist: [[0.52, 0.37, 0.19]], shine: 0.30, fuzz: true},
    twine: {width: 3.0, edge: [0.62, 0.58, 0.55], body: [0.98, 0.97, 0.95], twist: [[0.84, 0.20, 0.17], [0.98, 0.97, 0.95]], shine: 0.5},
    wire: {width: 2.2, edge: [0.25, 0.27, 0.30], body: [0.78, 0.80, 0.84], shine: 0.9},
    lights: {width: 1.6, edge: [0.08, 0.14, 0.09], body: [0.16, 0.27, 0.17], shine: 0.25, bulbs: true},
};

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
