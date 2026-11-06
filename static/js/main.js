(function () {
  "use strict";

  var MODELS = [
    { id: "crepe", label: "CRePE" },
    { id: "ucpe", label: "UCPE" },
  ];
  var SEEDS = [0, 1, 2];

  // "fisheye" = the generated video; the equirectangular views re-project it with the lens it was generated for
  // (tools/erp_videos.py): "erp_crop" fills the frame, "erp_full" keeps every pixel and leaves uncovered areas black.
  var VIEWS = [
    { id: "fisheye", label: "Fisheye" },
    { id: "erp_crop", label: "Equirect (crop)" },
    { id: "erp_full", label: "Equirect (full)" },
  ];
  function viewSuffix(view) {
    return view && view !== "fisheye" ? "_" + view : "";
  }
  function videoPath(scene, model, seed, view) {
    return "static/videos/" + scene + "/" + model + "_seed" + seed + viewSuffix(view) + ".mp4";
  }
  function posterPath(scene, model, seed, view) {
    return "static/posters/" + scene + "/" + model + "_seed" + seed + viewSuffix(view) + ".jpg";
  }
  function fmt(v) {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }
  function lensText(values, unit) {
    return values.length > 1 ? fmt(values[0]) + unit + " → " + fmt(values[1]) + unit : fmt(values[0]) + unit;
  }

  // ---- lazy playback: load and play only the videos that are on screen ----
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var observer = "IntersectionObserver" in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var v = entry.target;
      if (entry.isIntersecting) {
        if (!v.getAttribute("src") && v.dataset.src) v.src = v.dataset.src;
        if (!reduceMotion) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      } else if (!v.paused) {
        v.pause();
      }
    });
  }, { rootMargin: "200px 0px", threshold: 0.25 }) : null;

  function watch(video) {
    if (observer) { observer.observe(video); }
    else { video.src = video.dataset.src; video.controls = true; }
    if (reduceMotion) video.controls = true;
  }

  function setVideo(video, src, poster) {
    video.dataset.src = src;
    video.poster = poster;
    var visible = video.getAttribute("src") !== null;
    if (visible) {
      video.src = src;
      if (!reduceMotion) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
    }
  }

  // ---- input diagrams: lens fan + camera trajectory ----
  var SVGNS = "http://www.w3.org/2000/svg";
  var NUM_FRAMES = 81, FPS = 16;
  var RAMP = [[0, [106, 63, 191]], [0.5, [42, 157, 143]], [1, [242, 176, 46]]];  // violet -> teal -> gold

  function el(tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function rampColor(t) {
    for (var i = 1; i < RAMP.length; i++) {
      if (t <= RAMP[i][0]) {
        var a = RAMP[i - 1], b = RAMP[i], u = (t - a[0]) / (b[0] - a[0]);
        return "rgb(" + a[1].map(function (c, j) { return Math.round(c + (b[1][j] - c) * u); }).join(",") + ")";
      }
    }
    return "rgb(" + RAMP[RAMP.length - 1][1].join(",") + ")";
  }
  function lensAt(values, frame) {
    return values.length > 1 ? values[0] + (values[1] - values[0]) * frame / (NUM_FRAMES - 1) : values[0];
  }

  function lensDiagram(scene) {
    var svg = el("svg", { viewBox: "2 8 116 82", class: "lens-svg", role: "img" });
    var cx = 60, cy = 66, R = 54, r = 17;
    var wedge = el("path", { class: "lens-wedge" }, svg);
    el("line", { x1: cx, y1: cy, x2: cx, y2: cy - R - 2, class: "lens-axis" }, svg);
    var arc = el("path", { class: "lens-arc", fill: "none" }, svg);
    var fovLabel = el("text", { x: cx, y: cy - r - 4, class: "lens-label", "text-anchor": "middle" }, svg);
    el("rect", { x: cx - 7, y: cy - 1, width: 14, height: 9, rx: 2, class: "lens-cam" }, svg);
    el("rect", { x: cx - 3, y: cy - 3.5, width: 6, height: 3, rx: 1, class: "lens-cam" }, svg);
    var xiLabel = el("text", { x: cx, y: 87, class: "lens-label", "text-anchor": "middle" }, svg);

    function sector(radius, half) {
      var a = half * Math.PI / 180;
      var x1 = cx - radius * Math.sin(a), y1 = cy - radius * Math.cos(a);
      var x2 = cx + radius * Math.sin(a), y2 = cy - radius * Math.cos(a);
      return { start: x1.toFixed(2) + " " + y1.toFixed(2), end: x2.toFixed(2) + " " + y2.toFixed(2), large: half * 2 > 180 ? 1 : 0 };
    }
    function render(frame) {
      var fov = lensAt(scene.fov, frame), xi = lensAt(scene.xi, frame);
      var s = sector(R, fov / 2), t = sector(r, fov / 2);
      wedge.setAttribute("d", "M" + cx + " " + cy + " L" + s.start + " A" + R + " " + R + " 0 " + s.large + " 1 " + s.end + " Z");
      arc.setAttribute("d", "M" + t.start + " A" + r + " " + r + " 0 " + t.large + " 1 " + t.end);
      fovLabel.textContent = Math.round(fov) + "°";
      xiLabel.textContent = "ξ = " + xi.toFixed(scene.xi.length > 1 ? 2 : 1);
      svg.setAttribute("aria-label", "Lens: horizontal field of view " + Math.round(fov) + " degrees, xi " + xi.toFixed(2));
    }
    render(0);
    return { svg: svg, render: render, animated: scene.fov.length > 1 || scene.xi.length > 1 };
  }

  function trajectoryDiagram(scene) {
    var cam = scene.camera;
    var svg = el("svg", { viewBox: "0 0 160 100", class: "traj-svg", role: "img",
                          "aria-label": "Camera trajectory, colored from start (violet) to end (gold)" });
    var n = cam.path.length;
    cam.key.forEach(function (i) {
      var p = cam.frusta[i].pts, color = rampColor(i / (n - 1));
      var d = "";
      for (var k = 1; k <= 4; k++) d += "M" + p[0][0] + " " + p[0][1] + "L" + p[k][0] + " " + p[k][1];
      d += "M" + p[1][0] + " " + p[1][1] + "L" + p[2][0] + " " + p[2][1] + "L" + p[3][0] + " " + p[3][1] + "L" + p[4][0] + " " + p[4][1] + "Z";
      el("path", { d: d, stroke: color, class: "traj-frustum" }, svg);
    });
    for (var i = 1; i < n; i++) {
      el("line", { x1: cam.path[i - 1][0], y1: cam.path[i - 1][1], x2: cam.path[i][0], y2: cam.path[i][1],
                   stroke: rampColor(i / (n - 1)), class: "traj-line" }, svg);
    }
    var current = el("path", { class: "traj-current" }, svg);
    var dot = el("circle", { r: 2.4, class: "traj-dot" }, svg);
    function render(frame) {
      var f = Math.max(0, Math.min(n - 1, frame));
      var p = cam.frusta[f].pts, d = "";
      for (var k = 1; k <= 4; k++) d += "M" + p[0][0] + " " + p[0][1] + "L" + p[k][0] + " " + p[k][1];
      d += "M" + p[1][0] + " " + p[1][1] + "L" + p[2][0] + " " + p[2][1] + "L" + p[3][0] + " " + p[3][1] + "L" + p[4][0] + " " + p[4][1] + "Z";
      current.setAttribute("d", d);
      dot.setAttribute("cx", cam.path[f][0]);
      dot.setAttribute("cy", cam.path[f][1]);
    }
    render(0);
    return { svg: svg, render: render };
  }

  function inputsPanel(scene, video) {
    var wrap = document.createElement("div");
    wrap.className = "inputs";
    var lens = lensDiagram(scene), traj = trajectoryDiagram(scene);
    var tiles = [[lens.svg, lens.animated ? "Lens (sweep)" : "Lens"], [traj.svg, "Camera trajectory"]];
    // Reference: the dataset clip the trajectory comes from (same 81 frames at 16 fps, its own lens), kept in sync.
    var ref = null;
    if (scene.reference) {
      ref = document.createElement("video");
      ref.muted = true; ref.loop = true; ref.playsInline = true;
      ref.setAttribute("muted", ""); ref.setAttribute("playsinline", "");
      ref.preload = "none";
      ref.dataset.src = "static/videos/reference/" + scene.reference.clip + ".mp4";
      ref.poster = "static/posters/reference/" + scene.reference.clip + ".jpg";
      ref.setAttribute("aria-label", "Reference clip the camera trajectory was taken from");
      tiles.unshift([ref, "Reference · FoV " + fmt(scene.reference.fov) + "° · ξ " + fmt(scene.reference.xi)]);
      wrap.classList.add("has-ref");
      if (observer) observer.observe(ref); else ref.src = ref.dataset.src;
    }
    tiles.forEach(function (pair, i) {
      var fig = document.createElement("figure");
      if (ref && i === 0) fig.className = "ref";
      fig.appendChild(pair[0]);
      var cap = document.createElement("figcaption");
      cap.textContent = pair[1];
      fig.appendChild(cap);
      wrap.appendChild(fig);
    });
    function alignReference() {
      if (!ref || !ref.getAttribute("src") || ref.readyState < 2 || ref.seeking) return;
      if (Math.abs(ref.currentTime - video.currentTime) > 0.1) ref.currentTime = video.currentTime;
      if (video.paused !== ref.paused) {
        if (video.paused) ref.pause();
        else { var p = ref.play(); if (p && p.catch) p.catch(function () {}); }
      }
    }
    // Follow the video: current frame -> lens and camera marker, reference clip.
    var last = -1, handle = null;
    function sync() {
      var f = Math.min(NUM_FRAMES - 1, Math.floor((video.currentTime || 0) * FPS));
      if (f !== last) { last = f; traj.render(f); if (lens.animated) lens.render(f); }
      alignReference();
      if (!video.paused && !video.ended) handle = requestAnimationFrame(sync);
    }
    video.addEventListener("pause", alignReference);
    video.addEventListener("play", function () { if (handle) cancelAnimationFrame(handle); sync(); });
    video.addEventListener("seeked", sync);
    video.addEventListener("loadeddata", sync);
    return wrap;
  }

  function segmented(options, current, onSelect, label) {
    var group = document.createElement("div");
    group.className = "seg";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    options.forEach(function (opt) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = opt.label;
      b.dataset.value = opt.value;
      b.setAttribute("aria-pressed", String(opt.value === current));
      b.addEventListener("click", function () {
        group.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        onSelect(opt.value);
      });
      group.appendChild(b);
    });
    return group;
  }

  function buildCard(scene) {
    var pick = scene.picks[0];
    var state = { model: pick.model, seed: pick.seed, view: "fisheye" };
    var card = document.createElement("article");
    card.className = "card";

    var video = document.createElement("video");
    video.muted = true; video.loop = true; video.playsInline = true;
    video.setAttribute("muted", ""); video.setAttribute("playsinline", "");
    video.preload = "none";
    video.dataset.src = videoPath(scene.id, state.model, state.seed);
    video.poster = posterPath(scene.id, state.model, state.seed);
    video.setAttribute("aria-label", scene.title);
    card.appendChild(video);
    card.appendChild(inputsPanel(scene, video));

    var h = document.createElement("h3");
    h.textContent = scene.title;
    card.appendChild(h);

    var chips = document.createElement("div");
    chips.className = "chips";
    var sweep = scene.fov.length > 1;
    var lens = document.createElement("span");
    lens.className = "chip lens";
    lens.textContent = "FoV " + lensText(scene.fov, "°") + " · ξ " + lensText(scene.xi, "");
    chips.appendChild(lens);
    if (sweep) {
      var s = document.createElement("span");
      s.className = "chip sweep";
      s.textContent = "lens sweep";
      chips.appendChild(s);
    }
    var tr = document.createElement("span");
    tr.className = "chip";
    tr.textContent = scene.trajectory + " trajectory";
    chips.appendChild(tr);
    card.appendChild(chips);

    function update() {
      video.classList.toggle("erp", state.view !== "fisheye");
      setVideo(video, videoPath(scene.id, state.model, state.seed, state.view),
               posterPath(scene.id, state.model, state.seed, state.view));
    }
    var controls = document.createElement("div");
    controls.className = "controls";
    controls.appendChild(segmented(MODELS.map(function (m) { return { label: m.label, value: m.id }; }), state.model,
      function (v) { state.model = v; update(); }, "Checkpoint"));
    controls.appendChild(segmented(SEEDS.map(function (s) { return { label: "seed " + s, value: s }; }), state.seed,
      function (v) { state.seed = v; update(); }, "Seed"));
    controls.appendChild(segmented(VIEWS.map(function (m) { return { label: m.label, value: m.id }; }), state.view,
      function (v) { state.view = v; update(); }, "View"));
    card.appendChild(controls);

    var cap = document.createElement("p");
    cap.className = "caption";
    cap.textContent = "“" + scene.caption + "”";
    cap.title = "Show full prompt";
    cap.addEventListener("click", function () { cap.classList.toggle("open"); });
    card.appendChild(cap);

    watch(video);
    return card;
  }

  var grid = document.getElementById("showcase-grid");
  if (grid && window.CREPE_SHOWCASE) {
    window.CREPE_SHOWCASE.forEach(function (scene) { grid.appendChild(buildCard(scene)); });
  }
  document.querySelectorAll(".teaser-strip video").forEach(watch);

  // ---- internal geometry: generated clip + the radial head's inverse distance, kept in sync ----
  function follow(master, follower) {
    function align() {
      if (!follower.getAttribute("src") || follower.readyState < 2 || follower.seeking) return;
      if (Math.abs(follower.currentTime - master.currentTime) > 0.1) follower.currentTime = master.currentTime;
      if (master.paused !== follower.paused) {
        if (master.paused) follower.pause();
        else { var p = follower.play(); if (p && p.catch) p.catch(function () {}); }
      }
    }
    ["timeupdate", "play", "pause", "seeked"].forEach(function (e) { master.addEventListener(e, align); });
    follower.addEventListener("play", function () { if (master.paused) follower.pause(); });
    follower.addEventListener("loadeddata", align);
  }
  (function () {
    var grid = document.getElementById("geometry-grid"), data = window.CREPE_GEOMETRY, scenes = {};
    if (!grid || !data || !window.CREPE_SHOWCASE) return;
    window.CREPE_SHOWCASE.forEach(function (s) { scenes[s.id] = s; });
    function clip(src, poster, label) {
      var v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true;
      v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
      v.preload = "none"; v.dataset.src = src; v.poster = poster; v.setAttribute("aria-label", label);
      return v;
    }
    data.examples.forEach(function (ex) {
      var scene = scenes[ex.scene];
      var card = document.createElement("article");
      card.className = "geo-card";
      var v = clip(videoPath(ex.scene, "crepe", ex.seed), posterPath(ex.scene, "crepe", ex.seed), scene.title);
      var g = clip("static/videos/geometry/" + ex.scene + "/crepe_seed" + ex.seed + ".mp4",
                   "static/posters/geometry/" + ex.scene + "/crepe_seed" + ex.seed + ".jpg",
                   "Inverse distance predicted by CRePE's radial head for " + scene.title);
      card.appendChild(v); card.appendChild(g);
      var meta = document.createElement("div");
      meta.className = "geo-meta";
      var t = document.createElement("span"); t.className = "geo-title"; t.textContent = scene.title;
      var c = document.createElement("span"); c.className = "chip lens";
      c.textContent = "FoV " + lensText(scene.fov, "°") + " · ξ " + lensText(scene.xi, "");
      meta.appendChild(t); meta.appendChild(c);
      card.appendChild(meta);
      grid.appendChild(card);
      watch(v); watch(g); follow(v, g);
    });
  })();

  // ---- camera-control comparison: CRePE vs UCPE with the camera ViPE recovers from each video ----
  // Data: static/js/camera-data.js (tools/vipe_tracks.py). Poses are relative to frame 0 with translation scaled to
  // unit maximum length (the paper's pose protocol); camera axes are OpenCV (x right, y down, z forward).
  (function () {
    var root = document.getElementById("camera-compare");
    var data = window.CREPE_CAMERA, scenes = {};
    if (!root || !data || !data.length || !window.CREPE_SHOWCASE) return;
    window.CREPE_SHOWCASE.forEach(function (s) { scenes[s.id] = s; });
    var SERIES = [
      { id: "requested", label: "Requested", color: "--muted", dash: [5, 4] },
      { id: "crepe", label: "CRePE", color: "--accent" },
      { id: "ucpe", label: "UCPE", color: "--accent2" },
    ];
    var KEYS = [0, 20, 40, 60, 80], HOME = { yaw: -0.15, pitch: -1.3 };   // from above, slightly behind
    var vids = {};
    root.querySelectorAll("video").forEach(function (v) { vids[v.dataset.role] = v; watch(v); });
    var master = vids.crepe, followers = [vids.ucpe, vids.reference];
    var videosEl = root.querySelector(".cc-videos");
    var canvas = root.querySelector(".cc-3d canvas"), chart = root.querySelector(".cc-pan svg");
    var tbody = root.querySelector(".cc-table tbody"), playBtn = root.querySelector(".cc-play");
    var scrub = root.querySelector(".cc-scrub"), frameEl = root.querySelector(".cc-frame");
    var titleEl = root.querySelector(".cc-title"), chipsEl = root.querySelector(".cc-chips");
    var promptEl = root.querySelector(".cc-prompt"), refLabel = root.querySelector(".cc-ref-label");
    var thumbsEl = root.querySelector(".cc-thumbs");
    var ex = null, tracks = [], view = { yaw: HOME.yaw, pitch: HOME.pitch }, drag = null, raf = 0, frame = -1;
    var userPaused = false, buttons = [];

    function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; }
    function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    function add(a, b, s) { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
    function yawDeg(f) { return Math.atan2(f[0], f[2]) * 180 / Math.PI; }
    function currentFrame() { return Math.min(NUM_FRAMES - 1, Math.max(0, Math.floor((master.currentTime || 0) * FPS))); }

    // ---- 3D view (orthographic, drag to rotate) ----
    var center = [0, 0, 0], radius = 1, size = 0.1, fit = { s: 1, cx: 0, cy: 0 };
    function rotate(p) {
      var x = p[0] - center[0], y = -(p[1] - center[1]), z = p[2] - center[2];   // display: y up
      var cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
      var x1 = cy * x + sy * z, z1 = -sy * x + cy * z;
      return [x1, cp * y - sp * z1];
    }
    function frustum(tr, i) {
      var p = tr.pos[i], f = tr.fwd[i], u = tr.up[i], r = cross(f, u), c = add(p, f, size);
      return [p, add(add(c, r, 0.6 * size), u, 0.4 * size), add(add(c, r, -0.6 * size), u, 0.4 * size),
              add(add(c, r, -0.6 * size), u, -0.4 * size), add(add(c, r, 0.6 * size), u, -0.4 * size)];
    }
    function fitView(w, h) {
      var lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      tracks.forEach(function (t) { t.tr.pos.forEach(function (p) {
        for (var k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); } }); });
      center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      radius = Math.max(0.35, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
      size = 0.16 * radius;
      var a = [1e9, 1e9], b = [-1e9, -1e9];
      tracks.forEach(function (t) { t.tr.pos.forEach(function (p, i) {
        (i % 10 === 0 || i === NUM_FRAMES - 1 ? frustum(t.tr, i) : [p]).forEach(function (c) {
          var q = rotate(c);
          a[0] = Math.min(a[0], q[0]); b[0] = Math.max(b[0], q[0]); a[1] = Math.min(a[1], q[1]); b[1] = Math.max(b[1], q[1]);
        });
      }); });
      var sx = Math.max(b[0] - a[0], 0.3 * radius), sy = Math.max(b[1] - a[1], 0.3 * radius);
      fit.s = Math.min(w * 0.9 / sx, h * 0.86 / sy);
      fit.cx = (a[0] + b[0]) / 2; fit.cy = (a[1] + b[1]) / 2;
    }
    function project(p, w, h) { var q = rotate(p); return [w / 2 + fit.s * (q[0] - fit.cx), h / 2 - fit.s * (q[1] - fit.cy)]; }
    function pyramid(ctx, c) {
      ctx.beginPath();
      [1, 2, 3, 4].forEach(function (k) { ctx.moveTo(c[0][0], c[0][1]); ctx.lineTo(c[k][0], c[k][1]); });
      ctx.moveTo(c[1][0], c[1][1]); [2, 3, 4, 1].forEach(function (k) { ctx.lineTo(c[k][0], c[k][1]); });
      ctx.stroke();
    }
    function draw3d(f) {
      if (!ex) return;
      var dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      var ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      fitView(w, h);
      tracks.forEach(function (t) {
        var color = css(t.spec.color);
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineJoin = "round";
        ctx.globalAlpha = 1; ctx.lineWidth = t.spec.id === "requested" ? 1.8 : 2.4; ctx.setLineDash(t.spec.dash || []);
        ctx.beginPath();
        t.tr.pos.forEach(function (p, i) { var q = project(p, w, h); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
        KEYS.forEach(function (i) { pyramid(ctx, frustum(t.tr, i).map(function (p) { return project(p, w, h); })); });
        var c = frustum(t.tr, f).map(function (p) { return project(p, w, h); });
        ctx.globalAlpha = 0.16;
        ctx.beginPath(); ctx.moveTo(c[1][0], c[1][1]); [2, 3, 4].forEach(function (k) { ctx.lineTo(c[k][0], c[k][1]); }); ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 2.2;
        if (t.spec.dash) ctx.setLineDash([3, 3]);
        pyramid(ctx, c);
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(c[0][0], c[0][1], 3, 0, 2 * Math.PI); ctx.fill();
      });
      ctx.globalAlpha = 1;
    }

    // ---- pan chart (SVG) ----
    var CH = { x0: 38, x1: 312, y0: 12, y1: 162 }, chartParts = null;
    function svgEl(tag, attrs, parent) { return el(tag, attrs, parent); }
    function buildChart() {
      chart.innerHTML = "";
      var lo = 0, hi = 0;
      tracks.forEach(function (t) { t.yaw.forEach(function (v) { lo = Math.min(lo, v); hi = Math.max(hi, v); }); });
      var step = hi - lo > 30 ? 10 : 5;
      lo = Math.floor((lo - 1) / step) * step; hi = Math.ceil((hi + 1) / step) * step;
      var X = function (i) { return CH.x0 + (CH.x1 - CH.x0) * i / (NUM_FRAMES - 1); };
      var Y = function (v) { return CH.y1 - (CH.y1 - CH.y0) * (v - lo) / (hi - lo); };
      for (var v = lo; v <= hi + 1e-6; v += step) {
        svgEl("line", { x1: CH.x0, x2: CH.x1, y1: Y(v), y2: Y(v), class: v === 0 ? "cc-axis" : "cc-grid" }, chart);
        svgEl("text", { x: CH.x0 - 6, y: Y(v) + 3.5, class: "cc-tick", "text-anchor": "end" }, chart).textContent = v + "°";
      }
      [0, 20, 40, 60, 80].forEach(function (i) {
        svgEl("text", { x: X(i), y: CH.y1 + 14, class: "cc-tick", "text-anchor": "middle" }, chart).textContent = i;
      });
      svgEl("text", { x: CH.x1, y: CH.y1 + 26, class: "cc-tick", "text-anchor": "end" }, chart).textContent = "frame";
      var dots = [];
      tracks.forEach(function (t) {
        var d = t.yaw.map(function (v, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(v).toFixed(1); }).join("");
        svgEl("path", { d: d, class: "cc-line " + t.spec.id }, chart);
        dots.push(svgEl("circle", { r: 3.2, class: "cc-dot " + t.spec.id }, chart));
      });
      var head = svgEl("line", { y1: CH.y0, y2: CH.y1, class: "cc-head" }, chart);
      chart.insertBefore(head, chart.querySelector(".cc-line"));
      chartParts = { X: X, Y: Y, dots: dots, head: head };
      chart.setAttribute("aria-label", "Pan over time. At the last frame: " + tracks.map(function (t) {
        return t.spec.label + " " + t.yaw[NUM_FRAMES - 1].toFixed(1) + "°"; }).join(", "));
    }
    function drawChart(f) {
      if (!chartParts) return;
      var x = chartParts.X(f);
      chartParts.head.setAttribute("x1", x); chartParts.head.setAttribute("x2", x);
      tracks.forEach(function (t, k) {
        chartParts.dots[k].setAttribute("cx", x); chartParts.dots[k].setAttribute("cy", chartParts.Y(t.yaw[f]));
      });
    }

    // ---- playback: the CRePE video drives the others, the plots and the scrubber ----
    function align() {
      followers.forEach(function (v) {
        if (!v.getAttribute("src") || v.readyState < 2 || v.seeking || v.hidden) return;
        if (Math.abs(v.currentTime - master.currentTime) > 0.1) v.currentTime = master.currentTime;
        if (master.paused !== v.paused) {
          if (master.paused) v.pause();
          else { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        }
      });
    }
    function render(force) {
      var f = currentFrame();
      if (f !== frame || force) { frame = f; draw3d(f); drawChart(f); scrub.value = f; frameEl.textContent = "frame " + f; }
    }
    function loop() {
      raf = 0;
      render(false);
      align();
      if (!master.paused && !master.ended) raf = requestAnimationFrame(loop);
    }
    function kick() { if (!raf) raf = requestAnimationFrame(loop); }
    master.addEventListener("play", function () {
      if (userPaused) { master.pause(); return; }            // the visibility observer restarts playback
      playBtn.textContent = "Pause"; playBtn.setAttribute("aria-label", "Pause"); kick();
    });
    master.addEventListener("pause", function () { playBtn.textContent = "Play"; playBtn.setAttribute("aria-label", "Play"); align(); });
    master.addEventListener("seeked", function () { render(true); align(); });
    master.addEventListener("loadeddata", function () { render(true); });
    playBtn.addEventListener("click", function () {
      if (!master.getAttribute("src")) return;
      userPaused = !master.paused;
      if (userPaused) master.pause();
      else { var p = master.play(); if (p && p.catch) p.catch(function () {}); }
    });
    scrub.addEventListener("input", function () {
      userPaused = true;
      if (master.getAttribute("src")) { master.pause(); master.currentTime = (Number(scrub.value) + 0.5) / FPS; }
      frame = Number(scrub.value); draw3d(frame); drawChart(frame); frameEl.textContent = "frame " + frame;
    });
    canvas.addEventListener("pointerdown", function (e) { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", function (e) {
      if (!drag) return;
      view.yaw += (e.clientX - drag[0]) * 0.01;
      view.pitch = Math.max(-1.55, Math.min(1.55, view.pitch + (e.clientY - drag[1]) * 0.01));
      drag = [e.clientX, e.clientY];
      draw3d(Math.max(frame, 0));
    });
    canvas.addEventListener("pointerup", function () { drag = null; });
    canvas.addEventListener("dblclick", function () { view.yaw = HOME.yaw; view.pitch = HOME.pitch; draw3d(Math.max(frame, 0)); });
    window.addEventListener("resize", function () { render(true); });
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var redraw = function () { render(true); };
      if (mq.addEventListener) mq.addEventListener("change", redraw); else if (mq.addListener) mq.addListener(redraw);
    }

    followers.forEach(function (v) {
      v.addEventListener("play", function () { if (master.paused) v.pause(); });
    });

    // Each entry is either a lens-showcase clip (metadata from showcase-data.js) or a zero-shot RealCam-Vid clip
    // (metadata in camera-data.js; no reference video is redistributed).
    var GROUPS = { realcam: "Zero-shot · novel fast camera trajectories (RealCam-Vid)", showcase: "Strong lenses (lens showcase)" };
    function info(item) {
      if (item.kind === "realcam") {
        var base = "static/videos/realcam/" + item.id.split("_")[1] + "/", pbase = "static/posters/realcam/" + item.id.split("_")[1] + "/";
        return { key: item.id, group: "realcam", title: item.title, caption: item.caption, reference: null,
                 video: function (m) { return base + m + ".mp4"; }, poster: function (m) { return pbase + m + ".jpg"; },
                 chips: [["chip zero", "zero-shot"], ["chip lens", "FoV " + fmt(item.x_fov) + "° · pinhole"],
                         ["chip", "turns " + Math.round(item.turn_deg) + "° · travels " + fmt(item.travel_m) + " m"],
                         ["chip", "RealCam-Vid (" + item.source.replace("-10K", "") + ") camera"]] };
      }
      var scene = scenes[item.scene];
      var chips = [["chip lens", "FoV " + lensText(scene.fov, "°") + " · ξ " + lensText(scene.xi, "")]];
      if (scene.fov.length > 1) chips.push(["chip sweep", "lens sweep"]);
      chips.push(["chip", scene.trajectory + " trajectory"]);
      return { key: item.scene + item.seed, group: "showcase", title: scene.title + " · seed " + item.seed,
               caption: scene.caption, reference: scene.reference, chips: chips,
               video: function (m) { return videoPath(item.scene, m, item.seed); },
               poster: function (m) { return posterPath(item.scene, m, item.seed); } };
    }

    function show(item) {
      ex = item;
      userPaused = false;
      var meta = info(item);
      tracks = SERIES.map(function (spec) {
        var tr = spec.id === "requested" ? ex.requested : ex.runs[spec.id];
        return { spec: spec, tr: tr, yaw: tr.fwd.map(yawDeg) };
      });
      view.yaw = HOME.yaw; view.pitch = HOME.pitch;
      setVideo(master, meta.video("crepe"), meta.poster("crepe"));
      setVideo(vids.ucpe, meta.video("ucpe"), meta.poster("ucpe"));
      // without a redistributable reference clip, the two generated videos take the full width
      videosEl.classList.toggle("no-ref", !meta.reference);
      vids.reference.hidden = !meta.reference;
      if (meta.reference) {
        setVideo(vids.reference, "static/videos/reference/" + meta.reference.clip + ".mp4",
                 "static/posters/reference/" + meta.reference.clip + ".jpg");
        refLabel.textContent = "Reference clip · FoV " + fmt(meta.reference.fov) + "° · ξ " + fmt(meta.reference.xi);
      } else {
        vids.reference.pause();
      }
      followers.forEach(function (v) { if (v.getAttribute("src")) v.currentTime = 0; });
      titleEl.textContent = meta.title;
      chipsEl.innerHTML = "";
      meta.chips.forEach(function (c) {
        var el = document.createElement("span"); el.className = c[0]; el.textContent = c[1]; chipsEl.appendChild(el);
      });
      promptEl.textContent = "Prompt: “" + meta.caption + "”";
      promptEl.classList.remove("open");
      tbody.innerHTML = "";
      tracks.forEach(function (t) {
        var row = document.createElement("tr"), m = t.tr.metrics;
        var name = document.createElement("td");
        name.innerHTML = '<i class="sw ' + t.spec.id + '"></i>';
        name.appendChild(document.createTextNode(t.spec.label));
        row.appendChild(name);
        [(t.yaw[NUM_FRAMES - 1] >= 0 ? "+" : "−") + Math.abs(t.yaw[NUM_FRAMES - 1]).toFixed(1) + "°",
         m ? m.rot_err_deg.toFixed(1) + "°" : "–", m ? m.cammc.toFixed(2) : "–"].forEach(function (txt) {
          var td = document.createElement("td"); td.textContent = txt; row.appendChild(td);
        });
        tbody.appendChild(row);
      });
      buildChart();
      buttons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.key === meta.key)); });
      frame = -1;
      render(true);
      kick();
    }
    promptEl.addEventListener("click", function () { promptEl.classList.toggle("open"); });

    var rows = {};
    data.forEach(function (item) {
      var meta = info(item);
      if (!rows[meta.group]) {
        var h = document.createElement("h4"); h.textContent = GROUPS[meta.group]; thumbsEl.appendChild(h);
        rows[meta.group] = document.createElement("div"); rows[meta.group].className = "rg-row"; thumbsEl.appendChild(rows[meta.group]);
      }
      var b = document.createElement("button");
      b.type = "button"; b.className = "rg-thumb"; b.dataset.key = meta.key;
      b.setAttribute("aria-pressed", "false");
      var img = document.createElement("img");
      img.src = meta.poster("crepe"); img.alt = ""; img.loading = "lazy";
      var span = document.createElement("span");
      span.textContent = meta.title;
      b.appendChild(img); b.appendChild(span);
      b.addEventListener("click", function () { show(item); });
      rows[meta.group].appendChild(b);
      buttons.push(b);
    });
    show(data[0]);
  })();

  // ---- camera + radial-map gallery: one synced player, thumbnails grouped by source ----
  (function () {
    var root = document.getElementById("radial-gallery");
    var data = window.CREPE_RADIAL;
    if (!root || !data || !data.length) return;
    var MODE_LABEL = { gen: "From noise", transfer: "Motion transfer" };
    var vids = {};
    root.querySelectorAll("video").forEach(function (v) { vids[v.dataset.role] = v; watch(v); });
    var master = vids.output;
    var titleEl = root.querySelector(".rg-title"), chipsEl = root.querySelector(".rg-chips");
    var modesEl = root.querySelector(".rg-modes"), promptEl = root.querySelector(".rg-prompt");
    var sourceEl = root.querySelector(".rg-source"), thumbsEl = root.querySelector(".rg-thumbs");
    var current = null, mode = null, buttons = [];

    function base(ex) { return "static/videos/radial/" + ex.id + "/"; }
    function poster(ex, key) { return "static/posters/radial/" + ex.id + "/" + key + ".jpg"; }
    function align() {
      ["reference", "radial_map"].forEach(function (k) {
        var v = vids[k];
        if (!v.getAttribute("src") || v.readyState < 1) return;
        if (Math.abs(v.currentTime - master.currentTime) > 0.12) { try { v.currentTime = master.currentTime; } catch (e) {} }
      });
    }
    master.addEventListener("timeupdate", align);
    master.addEventListener("seeked", align);
    master.addEventListener("play", align);

    function show(ex, wantMode) {
      current = ex;
      mode = ex.modes.indexOf(wantMode) >= 0 ? wantMode : ex.modes[0];
      setVideo(vids.reference, base(ex) + "reference.mp4", poster(ex, "reference"));
      setVideo(vids.radial_map, base(ex) + "radial_map.mp4", poster(ex, "radial_map"));
      setVideo(master, base(ex) + mode + ".mp4", poster(ex, mode));
      [vids.reference, vids.radial_map].forEach(function (v) { if (v.getAttribute("src")) v.currentTime = 0; });
      titleEl.textContent = ex.title;
      chipsEl.innerHTML = "";
      var lens = document.createElement("span");
      lens.className = "chip lens";
      lens.textContent = ex.fov == null ? "Fisheye lens" : ("FoV " + ex.fov + "° · ξ " + ex.xi);
      chipsEl.appendChild(lens);
      var grp = document.createElement("span");
      grp.className = "chip";
      grp.textContent = ex.group;
      chipsEl.appendChild(grp);
      modesEl.innerHTML = "";
      modesEl.appendChild(segmented(ex.modes.map(function (m) { return { label: MODE_LABEL[m], value: m }; }), mode,
        function (v) { mode = v; setVideo(master, base(current) + v + ".mp4", poster(current, v)); }, "Generation mode"));
      promptEl.textContent = "Prompt: “" + ex.prompt + "”";
      promptEl.classList.remove("open");
      sourceEl.textContent = ex.source + ".";
      buttons.forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.id === ex.id)); });
    }
    promptEl.addEventListener("click", function () { promptEl.classList.toggle("open"); });

    var groups = [];
    data.forEach(function (ex) { if (groups.indexOf(ex.group) < 0) groups.push(ex.group); });
    groups.forEach(function (g) {
      var h = document.createElement("h4");
      h.textContent = g;
      thumbsEl.appendChild(h);
      var row = document.createElement("div");
      row.className = "rg-row";
      data.filter(function (ex) { return ex.group === g; }).forEach(function (ex) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "rg-thumb";
        b.dataset.id = ex.id;
        b.setAttribute("aria-pressed", "false");
        var img = document.createElement("img");
        img.src = poster(ex, ex.modes[0]);
        img.alt = "";
        img.loading = "lazy";
        var span = document.createElement("span");
        span.textContent = ex.title;
        b.appendChild(img);
        b.appendChild(span);
        b.addEventListener("click", function () { show(ex, mode); });
        row.appendChild(b);
        buttons.push(b);
      });
      thumbsEl.appendChild(row);
    });
    show(data[0], "gen");
  })();

  // The 3D explainer is an ES module, and browsers do not run modules on pages opened from file://.
  if (location.protocol === "file:") {
    var c3 = document.getElementById("crepe3d");
    if (c3) {
      c3.classList.add("no-webgl");
      var note = c3.querySelector(".c3-nogl");
      if (note) note.textContent = "Serve the page over http to see the 3D view (python -m http.server).";
    }
  }

  document.querySelectorAll("button.copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var el = document.querySelector(btn.dataset.copy);
      if (!el || !navigator.clipboard) return;
      navigator.clipboard.writeText(el.innerText).then(function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      });
    });
  });
})();
