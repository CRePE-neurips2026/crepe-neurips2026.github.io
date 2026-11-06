// Interactive CRePE explainer: a key token's radial distribution, its breakpoints lifted to 3D, their projection
// into a fisheye query camera (a curved path) and the expected rotary phasor (exact piecewise integration).
// The math follows crepe/crepe_attention.py of the code repository (K = 5 log-uniform breakpoints in
// [mu - sigma, mu + sigma] clamped to [-3, 3], UCM projection, bounded image coordinates normalize([u, v, 1])[:2],
// radial range, RoPE frequencies 2 pi / P_max * 3^j). Data: static/js/crepe3d-data.js (tools/crepe3d_data.py).
import * as THREE from "./vendor/three.module.min.js";
import { OrbitControls } from "./vendor/OrbitControls.js";

const D = window.CREPE_3D;
const root = document.getElementById("crepe3d");
if (D && root) init();

function init() {
  const W = D.width, H = D.height, TOKEN = D.token, K = 5, MAX_LOG = 3, XI = D.xi;
  const FX = (W / 2) * (Math.cos(rad(D.x_fov / 2)) + XI) / Math.sin(rad(D.x_fov / 2));
  const COORDS = [
    { id: "x", label: "x", maxPeriod: 8 },          // bounded image-plane coordinates
    { id: "y", label: "y", maxPeriod: 8 },
    { id: "r", label: "range", maxPeriod: 80 },     // radial range ||X||
  ];
  const STEPS = [
    "A key token predicts where its content lies along its ray: log-distance μ, uncertainty σ.",
    "K = 5 breakpoints, evenly spaced in log-distance over [μ − σ, μ + σ], are lifted to 3D.",
    "They are projected into the query camera with its fisheye lens: the path bends.",
    "The RoPE phasor is integrated exactly along each segment and averaged.",
  ];
  const RHO = 0.28;                                 // radius of the image domes around each camera
  const state = { mu: D.mu, sigma: D.sigma, query: 80, token: D.key_token.slice(), step: 0, coord: 0, freq: 2,
                  tour: true, sweep: 0 };

  // ---------------- geometry (OpenCV camera axes: x right, y down, z forward) ----------------
  function rad(d) { return d * Math.PI / 180; }
  function pose(i) { const p = D.poses[i]; return { R: [[p[0], p[1], p[2]], [p[4], p[5], p[6]], [p[8], p[9], p[10]]], t: [p[3], p[7], p[11]] }; }
  function camToWorld(P, v) { return [0, 1, 2].map((r) => P.R[r][0] * v[0] + P.R[r][1] * v[1] + P.R[r][2] * v[2] + P.t[r]); }
  function dirToWorld(P, v) { return [0, 1, 2].map((r) => P.R[r][0] * v[0] + P.R[r][1] * v[1] + P.R[r][2] * v[2]); }
  function worldToCam(P, X) {
    const d = [X[0] - P.t[0], X[1] - P.t[1], X[2] - P.t[2]];
    return [0, 1, 2].map((c) => P.R[0][c] * d[0] + P.R[1][c] * d[1] + P.R[2][c] * d[2]);
  }
  function norm(v) { return Math.hypot(v[0], v[1], v[2]); }
  function unproject(u, v) {                        // pixel -> unit UCM ray
    const x = (u - W / 2) / FX, y = (v - H / 2) / FX, r2 = x * x + y * y;
    const g = (XI + Math.sqrt(1 + (1 - XI * XI) * r2)) / (1 + r2);
    const d = [g * x, g * y, g - XI], n = norm(d);
    return [d[0] / n, d[1] / n, d[2] / n];
  }
  function project(X) {                             // camera point -> pixel (null if outside the UCM domain)
    const a = X[2] + XI * norm(X);
    return a > 1e-6 ? [FX * X[0] / a + W / 2, FX * X[1] / a + H / 2] : null;
  }
  function encode(px, X) {                          // CRePE's encoded coordinates of a projected point
    const u = (px[0] - W / 2) / W, v = (px[1] - H / 2) / H, s = Math.hypot(u, v, 1);
    return [u / s, v / s, Math.min(norm(X), 10)];
  }
  function decode(c) {                              // bounded image coordinates -> pixel
    const s = Math.sqrt(Math.max(1e-9, 1 - c[0] * c[0] - c[1] * c[1]));
    return [c[0] / s * W + W / 2, c[1] / s * H + H / 2];
  }
  const T3 = (p) => new THREE.Vector3(p[0], -p[1], -p[2]);   // OpenCV world -> three.js (rotation about x)

  function model() {
    const key = pose(0), q = pose(state.query);
    const ray = dirToWorld(key, unproject((state.token[0] + 0.5) * TOKEN, (state.token[1] + 0.5) * TOKEN));
    const lo = Math.max(-MAX_LOG, Math.min(MAX_LOG, state.mu - state.sigma));
    const hi = Math.max(-MAX_LOG, Math.min(MAX_LOG, state.mu + state.sigma));
    const at = (logd) => { const d = Math.min(100, Math.max(1e-2, Math.exp(logd))); return camToWorld(key, ray.map((r) => r * d)); };
    const view = (X) => { const Xc = worldToCam(q, X), px = project(Xc); return px ? { px: px, c: encode(px, Xc), X: X } : null; };
    const breaks = [];
    for (let k = 0; k < K; k++) { const ld = lo + (hi - lo) * k / (K - 1); breaks.push(Object.assign({ logd: ld, P: at(ld) }, view(at(ld)) || {})); }
    const dense = (a, b, n) => { const out = []; for (let i = 0; i <= n; i++) { const v = view(at(a + (b - a) * i / n)); if (v) out.push(v); } return out; };
    return { key: key, q: q, ray: ray, lo: lo, hi: hi, at: at, view: view, breaks: breaks,
             path: dense(lo, hi, 80), full: dense(-MAX_LOG, MAX_LOG, 160), mu: view(at(state.mu)) };
  }

  // ---------------- expected phasor (crepe_attention.expected_phasor_on_path) ----------------
  function omega() { const c = COORDS[state.coord]; return 2 * Math.PI / c.maxPeriod * Math.pow(3, state.freq); }
  function segmentMean(ta, tb, atol) {
    if (Math.abs(tb - ta) <= atol) return [Math.cos(ta), Math.sin(ta)];
    const d = tb - ta;
    return [(Math.sin(tb) - Math.sin(ta)) / d, (Math.cos(ta) - Math.cos(tb)) / d];
  }
  function expected(cs) {                           // cs: encoded coordinate values at the breakpoints
    const w = omega(), atol = cs.length === 2 ? 1e-2 : 1e-4, segs = [];
    for (let k = 0; k + 1 < cs.length; k++) segs.push(segmentMean(w * cs[k], w * cs[k + 1], atol));
    const m = segs.reduce((a, s) => [a[0] + s[0] / segs.length, a[1] + s[1] / segs.length], [0, 0]);
    return { segs: segs, mean: m };
  }

  // ---------------- DOM ----------------
  const canvas = root.querySelector(".c3-canvas canvas"), labels = root.querySelector(".c3-labels");
  const caption = root.querySelector(".c3-caption"), stepBtns = Array.from(root.querySelectorAll(".c3-step"));
  const tourBtn = root.querySelector(".c3-tour"), keyCv = root.querySelector(".c3-key canvas");
  const queryCv = root.querySelector(".c3-query canvas"), phasorCv = root.querySelector(".c3-phasor canvas");
  const muIn = root.querySelector("input[name=mu]"), sigmaIn = root.querySelector("input[name=sigma]");
  const freqIn = root.querySelector("input[name=freq]");
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
  const imgs = {};
  Object.keys(D.frames).forEach((k) => { const im = new Image(); im.src = D.frames[k]; im.onload = draw2d; imgs[k] = im; });

  // ---------------- three.js scene ----------------
  let renderer = null;
  try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true }); }
  catch (e) { root.classList.add("no-webgl"); }
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(38, 2, 0.01, 50);
  const controls = renderer ? new OrbitControls(cam, canvas) : null;
  if (controls) { controls.enableDamping = true; controls.dampingFactor = 0.12; controls.rotateSpeed = 0.7; }
  const loader = new THREE.TextureLoader(), textures = {};
  function tex(i) {
    if (!textures[i]) { textures[i] = loader.load(D.frames[i], () => { dirty = true; }); textures[i].colorSpace = THREE.SRGBColorSpace; }
    return textures[i];
  }
  const mats = {};
  function palette() {
    const c = (n) => new THREE.Color(css(n));
    mats.accent = new THREE.MeshBasicMaterial({ color: c("--accent") });
    mats.accentSoft = new THREE.MeshBasicMaterial({ color: c("--accent"), transparent: true, opacity: 0.35, depthWrite: false });
    mats.orange = new THREE.MeshBasicMaterial({ color: c("--accent2") });
    mats.orangeSoft = new THREE.MeshBasicMaterial({ color: c("--accent2"), transparent: true, opacity: 0.55 });
    mats.ink = new THREE.MeshBasicMaterial({ color: c("--ink") });
    mats.muted = new THREE.LineBasicMaterial({ color: c("--muted"), transparent: true, opacity: 0.6 });
    mats.rayLine = new THREE.LineBasicMaterial({ color: c("--accent"), transparent: true, opacity: 0.55 });
    mats.fullPath = new THREE.LineBasicMaterial({ color: c("--accent2"), transparent: true, opacity: 0.45 });
  }
  palette();
  let dyn = new THREE.Group(), domes = new THREE.Group();
  scene.add(domes, dyn);
  let grid = null;
  function floor() {
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    grid = new THREE.GridHelper(6, 24, new THREE.Color(css("--line")), new THREE.Color(css("--line")));
    grid.position.set(-0.5, -0.45, -1.2);
    scene.add(grid);
  }
  floor();

  function dome(i) {                                // the fisheye frame on the UCM unit sphere around camera i
    const P = pose(i), NX = 56, NY = 32, pos = [], uv = [], idx = [];
    for (let y = 0; y <= NY; y++) for (let x = 0; x <= NX; x++) {
      const u = W * x / NX, v = H * y / NY, d = unproject(u, v);
      const p = T3(camToWorld(P, d.map((a) => a * RHO)));
      pos.push(p.x, p.y, p.z); uv.push(x / NX, 1 - y / NY);
    }
    for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      const a = y * (NX + 1) + x, b = a + 1, c = a + NX + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex(String(i)), side: THREE.DoubleSide, transparent: true,
                                                              opacity: 0.93, depthWrite: false }));
    m.renderOrder = -1;
    const grp = new THREE.Group();
    grp.add(m, sphere(T3(P.t), 0.016, mats.ink));
    return grp;
  }
  function sphere(p, r, m) { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m); s.position.copy(p); return s; }
  function rod(a, b, r, m) {                        // cylinder from a to b
    const d = new THREE.Vector3().subVectors(b, a), len = d.length();
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10, 1, true), m);
    c.position.copy(a).addScaledVector(d, 0.5);
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return c;
  }
  class Polyline extends THREE.Curve {
    constructor(pts) { super(); this.pts = pts; }
    getPoint(t, out = new THREE.Vector3()) {
      const n = this.pts.length - 1, f = Math.min(n - 1e-6, Math.max(0, t * n)), i = Math.floor(f);
      return out.copy(this.pts[i]).lerp(this.pts[i + 1], f - i);
    }
  }
  function tube(pts, r, m) { return new THREE.Mesh(new THREE.TubeGeometry(new Polyline(pts), Math.max(8, pts.length * 2), r, 8, false), m); }
  function line(pts, m) { return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), m); }
  function onDome(P, X, s) {                        // central projection of world point X onto camera P's dome
    const d = [X[0] - P.t[0], X[1] - P.t[1], X[2] - P.t[2]], n = norm(d);
    return T3([P.t[0] + d[0] / n * RHO * s, P.t[1] + d[1] / n * RHO * s, P.t[2] + d[2] / n * RHO * s]);
  }

  let M = null, labelEls = {}, sweepObjs = null;
  function clear(g) {
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && !Object.values(mats).includes(o.material)) o.material.dispose(); });
    g.clear();
  }
  function rebuildDomes() {
    clear(domes);
    domes.add(dome(0));
    if (state.step >= 2) domes.add(dome(state.query));
    const traj = []; for (let i = 0; i < D.poses.length; i++) traj.push(T3(pose(i).t));
    domes.add(line(traj, mats.muted));
  }
  function rebuild() {
    M = model();
    clear(dyn);
    const key = M.key, k0 = T3(key.t), step = state.step;
    // token patch on the key dome
    const t0 = state.token[0] * TOKEN, t1 = t0 + TOKEN, s0 = state.token[1] * TOKEN, s1 = s0 + TOKEN;
    const corner = (u, v) => T3(camToWorld(key, unproject(u, v).map((a) => a * RHO * 1.01)));
    const quad = new THREE.BufferGeometry().setFromPoints([corner(t0, s0), corner(t1, s0), corner(t1, s1), corner(t0, s0), corner(t1, s1), corner(t0, s1)]);
    dyn.add(new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ color: css("--accent"), side: THREE.DoubleSide })));
    // ray and radial interval
    const far = Math.max(2.4, Math.exp(M.hi) * 1.25);
    dyn.add(line([k0, T3(M.at(Math.log(far)))], mats.rayLine));
    dyn.add(rod(T3(M.at(M.lo)), T3(M.at(Math.max(M.hi, M.lo + 1e-3))), 0.012, mats.accentSoft));
    if (step === 0) dyn.add(sphere(T3(M.at(state.mu)), 0.026, mats.accent));
    if (step >= 1) M.breaks.forEach((b) => dyn.add(sphere(T3(b.P), 0.022, mats.accent)));
    if (step >= 2) {
      const q = M.q, qc = T3(q.t);
      M.breaks.forEach((b) => { if (b.px) { dyn.add(rod(T3(b.P), qc, 0.0035, mats.orangeSoft)); dyn.add(sphere(onDome(q, b.P, 1.0), 0.012, mats.orange)); } });
      if (M.path.length > 1) dyn.add(tube(M.path.map((p) => onDome(q, p.X, 1.006)), 0.0065, mats.orange));
      if (M.full.length > 1) dyn.add(line(M.full.map((p) => onDome(q, p.X, 1.004)), mats.fullPath));
      sweepObjs = { ball: sphere(new THREE.Vector3(), 0.03, mats.orange), dot: sphere(new THREE.Vector3(), 0.015, mats.orange),
                    beam: line([new THREE.Vector3(), new THREE.Vector3()], new THREE.LineBasicMaterial({ color: css("--accent2") })) };
      dyn.add(sweepObjs.ball, sweepObjs.dot, sweepObjs.beam);
    } else sweepObjs = null;
    buildLabels();
    draw2d();
    dirty = true;
  }

  // ---------------- labels over the canvas ----------------
  function buildLabels() {
    labels.innerHTML = ""; labelEls = {};
    const add = (id, text, p, cls) => {
      const e = document.createElement("span"); e.className = "c3-label" + (cls ? " " + cls : ""); e.textContent = text;
      labels.appendChild(e); labelEls[id] = { el: e, p: p };
    };
    add("key", "key frame 0", T3(M.key.t));
    if (state.step >= 2) add("query", "query frame " + state.query, T3(M.q.t), "q");
    if (state.step === 0) add("mu", "μ", T3(M.at(state.mu)), "a");
    if (state.step >= 1) M.breaks.forEach((b, i) => add("b" + i, String(i + 1), T3(b.P), "a small"));
  }
  function placeLabels() {
    const w = canvas.clientWidth, h = canvas.clientHeight, v = new THREE.Vector3();
    Object.values(labelEls).forEach((l) => {
      v.copy(l.p).project(cam);
      const hide = v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
      l.el.style.display = hide ? "none" : "";
      l.el.style.left = ((v.x + 1) / 2 * w) + "px"; l.el.style.top = ((1 - v.y) / 2 * h) + "px";
    });
  }

  // ---------------- camera moves ----------------
  let tween = null;
  function viewFor(step) {
    const k0 = T3(M.key.t), rd = T3(M.ray).normalize(), up = new THREE.Vector3(0, 1, 0);
    const dmid = Math.exp((M.lo + M.hi) / 2), mid = k0.clone().addScaledVector(rd, dmid), qc = T3(pose(state.query).t);
    const side = new THREE.Vector3().crossVectors(rd, up).normalize();
    if (step === 0) {                               // over the shoulder of the key camera, along its ray
      return { target: k0.clone().addScaledVector(rd, 0.75),
               pos: k0.clone().addScaledVector(rd, -0.6).addScaledVector(up, 0.32).addScaledVector(side, 0.45) };
    }
    if (step === 1) {                               // from the side: breakpoint spacing along the ray
      const far = Math.exp(M.hi), target = k0.clone().addScaledVector(rd, 0.45 * far), d = 0.95 * far + 0.7;
      return { target: target, pos: target.clone().addScaledVector(side, d).addScaledVector(up, 0.3 * d) };
    }
    const far = k0.clone().addScaledVector(rd, Math.exp(M.hi)), pts = [k0, qc, mid, far];
    const target = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const R = Math.max(0.6, ...pts.map((p) => p.distanceTo(target)));
    return { target: target, pos: target.clone().addScaledVector(new THREE.Vector3(0.45, 1.05, 1.15).normalize(), 1.95 * R) };
  }
  function flyTo(step, instant) {
    if (!controls) return;
    const v = viewFor(step);
    if (instant) { cam.position.copy(v.pos); controls.target.copy(v.target); controls.update(); dirty = true; return; }
    tween = { t0: performance.now(), dur: 1100, p0: cam.position.clone(), q0: controls.target.clone(), p1: v.pos, q1: v.target };
  }
  if (controls) controls.addEventListener("start", () => { tween = null; stopTour(); });
  if (controls) controls.addEventListener("change", () => { dirty = true; });

  // ---------------- 2D panels ----------------
  function fit(cv) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }
  function drawImage(ctx, img, w, h) { if (img && img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, w, h); }
  function dot(ctx, x, y, r, fill, stroke) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.lineWidth = 1.5; ctx.strokeStyle = stroke; ctx.stroke(); }
  }
  function polyline(ctx, pts, color, width, dash) {
    if (pts.length < 2) return;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([]);
  }
  function drawKey() {
    const f = fit(keyCv), s = f.w / W, a = css("--accent");
    drawImage(f.ctx, imgs["0"], f.w, f.h);
    f.ctx.lineWidth = 2; f.ctx.strokeStyle = "#fff"; f.ctx.strokeRect(state.token[0] * TOKEN * s - 1, state.token[1] * TOKEN * s - 1, TOKEN * s + 2, TOKEN * s + 2);
    f.ctx.strokeStyle = a; f.ctx.strokeRect(state.token[0] * TOKEN * s, state.token[1] * TOKEN * s, TOKEN * s, TOKEN * s);
  }
  function drawQuery() {
    const f = fit(queryCv), s = f.w / W, ctx = f.ctx, o = css("--accent2"), a = css("--accent");
    drawImage(ctx, imgs[String(state.query)], f.w, f.h);
    if (!M) return;
    const px = (p) => [p[0] * s, p[1] * s];
    if (state.step >= 2) {
      polyline(ctx, M.full.map((p) => px(p.px)), "rgba(255,255,255,0.75)", 1.2, [4, 4]);
      const bs = M.breaks.filter((b) => b.px);
      if (bs.length >= 2) {
        const c0 = bs[0].c, c1 = bs[bs.length - 1].c, chord = [];
        for (let i = 0; i <= 20; i++) chord.push(px(decode([c0[0] + (c1[0] - c0[0]) * i / 20, c0[1] + (c1[1] - c0[1]) * i / 20])));
        polyline(ctx, chord, "rgba(20,20,20,0.85)", 3, [6, 4]);
        polyline(ctx, chord, "rgba(255,255,255,0.9)", 1.4, [6, 4]);
      }
      polyline(ctx, M.path.map((p) => px(p.px)), "#fff", 5);
      polyline(ctx, M.path.map((p) => px(p.px)), o, 3);
      bs.forEach((b, i) => {
        const p = px(b.px); dot(ctx, p[0], p[1], 5.5, a, "#fff");
        ctx.font = "600 11px Inter, system-ui, sans-serif"; ctx.fillStyle = "#fff"; ctx.fillText(String(M.breaks.indexOf(b) + 1), p[0] + 7, p[1] - 6);
      });
      const sw = sweepPoint();
      if (sw) { const p = px(sw.px); dot(ctx, p[0], p[1], 4, o, "#fff"); }
    }
  }
  function sweepPoint() { return M ? M.view(M.at(M.lo + (M.hi - M.lo) * state.sweep)) : null; }
  function drawPhasor() {
    const f = fit(phasorCv), ctx = f.ctx, a = css("--accent"), o = css("--accent2"), mu = css("--muted"), ink = css("--ink");
    const R = Math.min(f.h / 2 - 16, f.w * 0.3), cx = R + 16, cy = f.h / 2;
    const P = (z, r) => [cx + R * (r === undefined ? 1 : r) * z[0], cy - R * (r === undefined ? 1 : r) * z[1]];
    ctx.strokeStyle = css("--line"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - R - 6, cy); ctx.lineTo(cx + R + 6, cy); ctx.moveTo(cx, cy - R - 6); ctx.lineTo(cx, cy + R + 6); ctx.stroke();
    if (!M) return;
    const ci = state.coord, w = omega(), bs = M.breaks.filter((b) => b.c);
    const legend = []; let magText = "";
    if (bs.length >= 2 && state.step >= 3) {
      const cs = bs.map((b) => b.c[ci]), th = cs.map((c) => w * c), E = expected(cs), E2 = expected([cs[0], cs[cs.length - 1]]);
      // phase path along the circle (the phase moves linearly between breakpoints)
      ctx.strokeStyle = a; ctx.globalAlpha = 0.45; ctx.lineWidth = 2;
      for (let k = 0; k + 1 < th.length; k++) { ctx.beginPath(); ctx.arc(cx, cy, R, -th[k], -th[k + 1], th[k + 1] > th[k]); ctx.stroke(); }
      ctx.globalAlpha = 1;
      th.forEach((t, k) => { const p = P([Math.cos(t), Math.sin(t)]); dot(ctx, p[0], p[1], 4.5, a, "#fff"); ctx.fillStyle = ink; ctx.font = "600 10px Inter, system-ui, sans-serif"; ctx.fillText(String(k + 1), p[0] + 6, p[1] - 5); });
      E.segs.forEach((z) => { const p = P(z); dot(ctx, p[0], p[1], 3.2, null, a); });
      if (M.mu && M.mu.c) {                         // a single point at mu: plain RoPE, no uncertainty
        const t = w * M.mu.c[ci], p = P([Math.cos(t), Math.sin(t)]);
        ctx.setLineDash([4, 3]); ctx.strokeStyle = mu; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p[0], p[1]); ctx.stroke(); ctx.setLineDash([]);
      }
      const e2 = P(E2.mean); ctx.save(); ctx.translate(e2[0], e2[1]); ctx.rotate(Math.PI / 4); ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.strokeRect(-4, -4, 8, 8); ctx.restore();
      const e = P(E.mean); arrow(ctx, cx, cy, e[0], e[1], a, 3);
      const sw = sweepPoint();
      if (sw) { const t = w * sw.c[ci], p = P([Math.cos(t), Math.sin(t)]); dot(ctx, p[0], p[1], 4, o, "#fff"); }
      const mag = Math.hypot(E.mean[0], E.mean[1]);
      legend.push([a, "arrow", "expected"], [a, "ring", "segment means"], [ink, "diamond", "endpoints only"],
                  [mu, "dash", "point at μ"]);
      magText = "|E| = " + mag.toFixed(2);
    } else legend.push([mu, "text", "see step ④"]);
    const lx = cx + R + 20;
    ctx.font = "600 14px Inter, system-ui, sans-serif"; ctx.fillStyle = ink; ctx.fillText("e", lx, 20);
    ctx.font = "600 10px Inter, system-ui, sans-serif"; ctx.fillText("iωc", lx + ctx.measureText("e").width + 6, 13);
    ctx.font = "11px Inter, system-ui, sans-serif"; ctx.fillStyle = mu;
    ctx.fillText("c: " + COORDS[ci].label + "   ω = " + w.toFixed(2), lx, 36);
    if (magText) { ctx.font = "600 12px Inter, system-ui, sans-serif"; ctx.fillStyle = a; ctx.fillText(magText, lx, 54); }
    legend.forEach((l, i) => {
      const y = 76 + i * 17; ctx.fillStyle = mu; ctx.strokeStyle = l[0]; ctx.lineWidth = 2;
      if (l[1] === "arrow") arrow(ctx, lx, y - 4, lx + 14, y - 4, l[0], 2);
      if (l[1] === "ring") dot(ctx, lx + 7, y - 4, 3.2, null, l[0]);
      if (l[1] === "diamond") { ctx.save(); ctx.translate(lx + 7, y - 4); ctx.rotate(Math.PI / 4); ctx.lineWidth = 1.5; ctx.strokeRect(-3.5, -3.5, 7, 7); ctx.restore(); }
      if (l[1] === "dash") { ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(lx, y - 4); ctx.lineTo(lx + 14, y - 4); ctx.stroke(); ctx.setLineDash([]); }
      ctx.fillStyle = l[1] === "text" ? mu : css("--ink");
      ctx.fillText(l[2], l[1] === "text" ? lx : lx + 20, y);
    });
  }
  function arrow(ctx, x0, y0, x1, y1, color, width) {
    const ang = Math.atan2(y1 - y0, x1 - x0), L = Math.hypot(x1 - x0, y1 - y0), hd = Math.min(8, L * 0.4);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - hd * Math.cos(ang) * 0.6, y1 - hd * Math.sin(ang) * 0.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - hd * Math.cos(ang - 0.45), y1 - hd * Math.sin(ang - 0.45));
    ctx.lineTo(x1 - hd * Math.cos(ang + 0.45), y1 - hd * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill();
  }
  function draw2d() { drawKey(); drawQuery(); drawPhasor(); }

  // ---------------- steps, tour, controls ----------------
  function setStep(s, fromTour) {
    const domesChange = (s >= 2) !== (state.step >= 2) || !M;
    state.step = s;
    stepBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(i === s)));
    caption.textContent = STEPS[s];
    root.querySelector(".c3-query").classList.toggle("on", s === 2);
    root.querySelector(".c3-phasor").classList.toggle("on", s === 3);
    if (domesChange) rebuildDomes();
    rebuild();
    flyTo(s, false);
    tourClock = performance.now();
  }
  let tourClock = performance.now();
  function stopTour() { state.tour = false; tourBtn.textContent = "Play tour"; tourBtn.setAttribute("aria-pressed", "false"); }
  tourBtn.addEventListener("click", () => {
    state.tour = !state.tour;
    tourBtn.textContent = state.tour ? "Pause tour" : "Play tour"; tourBtn.setAttribute("aria-pressed", String(state.tour));
    tourClock = performance.now();
  });
  stepBtns.forEach((b, i) => b.addEventListener("click", () => { stopTour(); setStep(i); }));
  function readouts() {
    root.querySelector(".v-mu").textContent = state.mu.toFixed(2);
    root.querySelector(".v-sigma").textContent = state.sigma.toFixed(2);
    root.querySelector(".v-freq").textContent = String(state.freq + 1);
  }
  function onSlider() {
    state.mu = Number(muIn.value); state.sigma = Number(sigmaIn.value); state.freq = Number(freqIn.value) - 1;
    readouts();
    rebuild();
  }
  [muIn, sigmaIn, freqIn].forEach((el) => el.addEventListener("input", () => { stopTour(); onSlider(); }));
  muIn.value = state.mu; sigmaIn.value = state.sigma; freqIn.value = state.freq + 1; readouts();
  root.querySelectorAll(".c3-frame button").forEach((b) => b.addEventListener("click", () => {
    stopTour(); state.query = Number(b.dataset.frame);
    root.querySelectorAll(".c3-frame button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (state.step < 2) setStep(2); else { rebuildDomes(); rebuild(); flyTo(state.step, false); }
  }));
  root.querySelectorAll(".c3-coord button").forEach((b) => b.addEventListener("click", () => {
    stopTour(); state.coord = Number(b.dataset.coord);
    root.querySelectorAll(".c3-coord button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (state.step < 3) setStep(3); else draw2d();
  }));
  keyCv.addEventListener("click", (e) => {            // pick another key token
    const r = keyCv.getBoundingClientRect(), u = (e.clientX - r.left) / r.width * W, v = (e.clientY - r.top) / r.height * H;
    stopTour(); state.token = [Math.min(W / TOKEN - 1, Math.floor(u / TOKEN)), Math.min(H / TOKEN - 1, Math.floor(v / TOKEN))];
    rebuild();
  });

  // ---------------- render loop (only while on screen) ----------------
  let dirty = true, visible = false, raf = 0, last = performance.now();
  function resize() {
    if (!renderer) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); dirty = true;
  }
  function frame(now) {
    raf = 0;
    if (!visible) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (state.tour && now - tourClock > 5200) setStep((state.step + 1) % STEPS.length, true);
    if (tween) {
      const u = Math.min(1, (now - tween.t0) / tween.dur), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      cam.position.lerpVectors(tween.p0, tween.p1, e); controls.target.lerpVectors(tween.q0, tween.q1, e);
      if (u >= 1) tween = null;
      dirty = true;
    }
    if (state.step >= 2) {
      state.sweep = (state.sweep + dt / 3.2) % 1;
      if (sweepObjs) {
        const X = M.at(M.lo + (M.hi - M.lo) * state.sweep), qc = T3(M.q.t), p = T3(X);
        sweepObjs.ball.position.copy(p); sweepObjs.dot.position.copy(onDome(M.q, X, 1.0));
        sweepObjs.beam.geometry.setFromPoints([p, qc]);
      }
      drawQuery(); if (state.step >= 3) drawPhasor();
      dirty = true;
    }
    if (controls) controls.update();
    if (renderer && dirty) { renderer.render(scene, cam); placeLabels(); dirty = false; }
    raf = requestAnimationFrame(frame);
  }
  const io = new IntersectionObserver((es) => {
    visible = es[0].isIntersecting;
    if (visible && !raf) { last = performance.now(); tourClock = performance.now(); raf = requestAnimationFrame(frame); }
  }, { threshold: 0.15 });
  io.observe(root);
  new ResizeObserver(() => { resize(); draw2d(); }).observe(canvas);
  const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (mq && mq.addEventListener) mq.addEventListener("change", () => { palette(); floor(); rebuildDomes(); rebuild(); });
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) stopTour();

  resize();
  setStep(0);
  flyTo(0, true);
}
