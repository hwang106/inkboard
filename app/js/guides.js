// Ruler and protractor. They float over the board at a fixed screen size (like Whiteboard's),
// so all positions here are CSS pixels inside the canvas. Fingers or the mouse move them; two
// fingers (or the mouse wheel over them) rotate them. The pen draws along their edges.
//
// guide: { x, y, a } — centre (protractor: centre of the straight edge) and angle in radians.

const DEG = Math.PI / 180, PX_PER_CM = 96 / 2.54;
const EDGE_REACH = 28;   // how far outside an edge (px) the pen still snaps to it

export class Guides {
  constructor() { this.ruler = null; this.prot = null; this.size = { w: 800, h: 600 }; }
  get any() { return !!(this.ruler || this.prot); }

  dims() {
    const m = Math.min(this.size.w, this.size.h);
    return { L: Math.min(820, Math.max(this.size.w, this.size.h) * 0.85), H: 72, R: Math.max(120, Math.min(220, m * 0.32)) };
  }
  toggle(kind) {
    const { w, h } = this.size;
    if (kind === "ruler") this.ruler = this.ruler ? null : { x: w / 2, y: h * 0.42, a: -10 * DEG };
    else this.prot = this.prot ? null : { x: w / 2, y: h * 0.62, a: 0 };
    return !!this[kind === "ruler" ? "ruler" : "prot"];
  }
  local(g, x, y) {   // -> [u along, v across (down)]
    const c = Math.cos(g.a), s = Math.sin(g.a), dx = x - g.x, dy = y - g.y;
    return [dx * c + dy * s, -dx * s + dy * c];
  }
  world(g, u, v) { const c = Math.cos(g.a), s = Math.sin(g.a); return [g.x + u * c - v * s, g.y + u * s + v * c]; }

  // Which guide's body is under (x, y)? The protractor is on top.
  hit(x, y) {
    const { L, H, R } = this.dims();
    if (this.prot) { const [u, v] = this.local(this.prot, x, y); if (v <= 4 && Math.hypot(u, v) <= R) return "prot"; }
    if (this.ruler) { const [u, v] = this.local(this.ruler, x, y); if (Math.abs(u) <= L / 2 && Math.abs(v) <= H / 2) return "ruler"; }
    return null;
  }

  // The pen came down at (x, y): if it's on or just outside an edge, return how to snap the stroke.
  // half: half the stroke width in px, so the line sits against the edge, not under it.
  snapFor(x, y, half = 1) {
    const { L, H, R } = this.dims(), off = half + 1;
    if (this.prot) {
      const g = this.prot, [u, v] = this.local(g, x, y), d = Math.hypot(u, v);
      if (v <= 10 && d >= R * 0.6 && d <= R + EDGE_REACH) {
        const r = R + off;
        return {
          kind: "arc", guide: "prot", startAng: angOf(u, v),
          snap: (px, py) => { const [pu, pv] = this.local(g, px, py); const t = angOf(pu, pv); return this.world(g, r * Math.cos(t), -r * Math.sin(t)); },
          readout: (px, py) => { const [pu, pv] = this.local(g, px, py); return angOf(pu, pv); },
        };
      }
      if (Math.abs(v) <= EDGE_REACH && Math.abs(u) <= R + 10 && (v > 0 || d < R * 0.6)) {
        return { kind: "line", guide: "prot", snap: (px, py) => { const [pu] = this.local(g, px, py); return this.world(g, clamp(pu, -R, R), off); } };
      }
    }
    if (this.ruler) {
      const g = this.ruler, [u, v] = this.local(g, x, y);
      if (Math.abs(u) <= L / 2 + EDGE_REACH && Math.abs(v) <= H / 2 + EDGE_REACH) {
        const ev = v < 0 ? -H / 2 - off : H / 2 + off;
        return { kind: "line", guide: "ruler", snap: (px, py) => { const [pu] = this.local(g, px, py); return this.world(g, clamp(pu, -L / 2, L / 2), ev); } };
      }
    }
    return null;
  }

  rotate(kind, by) {
    const g = this[kind]; if (!g) return;
    g.a = snapAngle(g.a + by);
  }

  // ctx: device pixels. z: board zoom (the ruler's centimetres follow the board's scale).
  draw(ctx, dpr, z, live) {
    if (!this.any) return;
    const { L, H, R } = this.dims();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const font = '11px "Segoe UI", system-ui, sans-serif';
    if (this.ruler) {
      const g = this.ruler;
      ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.a);
      ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
      ctx.fillStyle = "rgba(246,246,248,0.86)";
      roundRect(ctx, -L / 2, -H / 2, L, H, 6); ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1; ctx.stroke();
      // centimetres at the board's scale, numbered from the left end
      const cm = PX_PER_CM * z;
      let sub = cm >= 50 ? 10 : cm >= 20 ? 2 : 1, every = 1;
      if (cm < 8) every = cm < 2 ? 50 : cm < 4 ? 10 : 5;
      const step = cm * every / sub;
      ctx.strokeStyle = "#222"; ctx.fillStyle = "#222"; ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.beginPath();
      for (let i = 0, x = -L / 2; x <= L / 2 + 0.01; i++, x = -L / 2 + i * step) {
        const major = i % sub === 0, half = sub === 10 && i % 5 === 0;
        const len = major ? 16 : half ? 11 : 7;
        ctx.moveTo(x, -H / 2); ctx.lineTo(x, -H / 2 + len);
        if (major && x > -L / 2 + 4 && x < L / 2 - 8) ctx.fillText(String(i / sub * every), x, -H / 2 + 18);
      }
      ctx.stroke();
      const deg = ((Math.round(-g.a / DEG) % 180) + 180) % 180;
      pill(ctx, `${deg}°`, 0, 12);
      ctx.restore();
    }
    if (this.prot) {
      const g = this.prot;
      ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.a);
      ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
      ctx.fillStyle = "rgba(246,246,248,0.86)";
      ctx.beginPath(); ctx.arc(0, 0, R, Math.PI, 2 * Math.PI); ctx.closePath(); ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.strokeStyle = "#222"; ctx.fillStyle = "#222"; ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.beginPath();
      for (let d = 0; d <= 180; d++) {
        const t = d * DEG, c = Math.cos(t), s = -Math.sin(t), len = d % 10 === 0 ? 16 : d % 5 === 0 ? 11 : 6;
        ctx.moveTo(c * R, s * R); ctx.lineTo(c * (R - len), s * (R - len));
        if (d % 10 === 0 && R > 150 || d % 30 === 0) ctx.fillText(String(d), c * (R - 28), s * (R - 28));
      }
      ctx.moveTo(-6, 0); ctx.lineTo(6, 0); ctx.moveTo(0, -6); ctx.lineTo(0, 0);
      ctx.stroke();
      if (live && live.guide === "prot" && live.kind === "arc") {
        // the angle being drawn: from where the pen started to where it is now
        const a0 = live.startAng, a1 = live.now;
        ctx.strokeStyle = "rgba(43,89,195,0.9)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a0) * R * 0.55, -Math.sin(a0) * R * 0.55);
        ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a1) * R * 0.55, -Math.sin(a1) * R * 0.55); ctx.stroke();
        pill(ctx, `${Math.round(Math.abs(a1 - a0) / DEG)}°`, 0, -R * 0.3);
      } else {
        const deg = ((Math.round(-g.a / DEG) % 360) + 360) % 360;
        if (deg) pill(ctx, `${deg}°`, 0, -R * 0.3);
      }
      ctx.restore();
    }
    ctx.restore();
  }
}

function angOf(u, v) { const t = Math.atan2(-v, u); return t < 0 ? (t < -Math.PI / 2 ? Math.PI : 0) : t; }   // 0..π, above the base
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Rotation sticks to multiples of 15° when it's within 2° of one.
export function snapAngle(a) { const s = Math.round(a / (15 * DEG)) * 15 * DEG; return Math.abs(a - s) < 2 * DEG ? s : a; }
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
function pill(ctx, text, x, y) {
  ctx.save();
  ctx.font = '600 13px "Segoe UI", system-ui, sans-serif';
  const w = ctx.measureText(text).width + 16;
  ctx.fillStyle = "rgba(32,32,36,0.85)"; roundRect(ctx, x - w / 2, y - 11, w, 22, 11); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}
