#!/usr/bin/env python
"""Equirectangular re-projection of the showcase videos with the lens each clip was generated for.

    python tools/erp_videos.py <CRePE repo> [scene ...]

The lens of every scene (``x_fov``, ``xi`` and their per-frame schedules) is read from
``<repo>/demo/lens_showcase.json`` and applied with the release's Unified Camera Model:
``fx = (W / 2) (cos(fov / 2) + xi) / sin(fov / 2)``, principal point at the image centre, a camera-frame
direction ``d`` projects to ``fx * d_xy / (d_z + xi) + c`` (valid while ``d_z + xi > 0`` and ``1 + xi d_z > 0``).

For every ``_source_videos/<scene>/<model>_seed<k>.mp4`` this writes web encodes + posters of

* ``<model>_seed<k>_erp_full.mp4``: every pixel of the fisheye frame, longitude x latitude; black where the
  camera saw nothing (for lens sweeps the canvas covers the widest frame);
* ``<model>_seed<k>_erp_crop.mp4``: the largest centred rectangle that is covered in every frame.

Both keep the fisheye's angular resolution at the image centre (same degrees per pixel on both axes).
If a model follows the requested lens, straight lines and proportions look consistent in these views.
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import imageio.v3 as iio
import imageio_ffmpeg
import numpy as np

FF = imageio_ffmpeg.get_ffmpeg_exe()
root = Path(__file__).resolve().parents[1]
repo = Path(sys.argv[1])
only = set(sys.argv[2:])
W, H, T = 832, 480, 81
MAX_WIDTH = 1024


def lens_schedule(sample):
    def resolve(value, schedule):
        if schedule is None:
            return np.full(T, float(value), dtype=np.float64)
        start, end = float(schedule.get("start", value)), float(schedule.get("end", schedule.get("start", value)))
        kind = schedule.get("type", "linear")
        t = np.linspace(0.0, 1.0, T)
        if kind == "constant":
            return np.full(T, start)
        if kind == "linear":
            return start + (end - start) * t
        if kind == "cosine":
            return start + (end - start) * (0.5 - 0.5 * np.cos(np.pi * t))
        raise ValueError(kind)
    return resolve(sample["x_fov"], sample.get("x_fov_schedule")), resolve(sample["xi"], sample.get("xi_schedule"))


def focal(x_fov, xi):
    half = np.deg2rad(0.5 * x_fov)
    return 0.5 * W * (np.cos(half) + xi) / np.sin(half)


def pixel_directions(x_fov, xi):
    """Unit directions (x right, y down, z forward) of all image pixels; NaN outside the UCM domain."""
    f = focal(x_fov, xi)
    u, v = np.meshgrid(np.arange(W, dtype=np.float64), np.arange(H, dtype=np.float64))
    x, y = (u - W / 2) / f, (v - H / 2) / f
    r2 = x * x + y * y
    disc = 1.0 + (1.0 - xi * xi) * r2
    with np.errstate(invalid="ignore"):
        gamma = (xi + np.sqrt(disc)) / (r2 + 1.0)
    d = np.stack([gamma * x, gamma * y, gamma - xi], -1)
    d[disc < 0] = np.nan
    return d


def project(lon, lat, x_fov, xi):
    """ERP angles -> fisheye pixel maps (float32), -1 where invalid."""
    dx, dy, dz = np.cos(lat) * np.sin(lon), np.sin(lat), np.cos(lat) * np.cos(lon)
    f = focal(x_fov, xi)
    den = dz + xi
    ok = (den > 1e-9) & (1.0 + xi * dz > 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        u = f * dx / den + W / 2
        v = f * dy / den + H / 2
    ok &= (u >= 0) & (u <= W - 1) & (v >= 0) & (v <= H - 1)
    return np.where(ok, u, -1).astype(np.float32), np.where(ok, v, -1).astype(np.float32), ok


def layout(fovs, xis):
    """Angular grids of the full and the cropped view (shared by all videos of a scene)."""
    ppr = focal(fovs[0], xis[0]) / (1.0 + xis[0])          # pixels per radian at the image centre (frame 0)
    lon_max = lat_max = 0.0
    for f, x in zip(fovs, xis):
        d = pixel_directions(f, x)
        lon = np.arctan2(d[..., 0], d[..., 2])
        lat = np.arctan2(d[..., 1], np.hypot(d[..., 0], d[..., 2]))
        lon_max, lat_max = max(lon_max, np.nanmax(np.abs(lon))), max(lat_max, np.nanmax(np.abs(lat)))
    ppr = min(ppr, MAX_WIDTH / (2 * lon_max))
    half_w, half_h = int(np.ceil(lon_max * ppr)), int(np.ceil(lat_max * ppr))
    cols, rows = np.arange(-half_w, half_w + 1) / ppr, np.arange(-half_h, half_h + 1) / ppr
    lon, lat = np.meshgrid(cols, rows)
    valid_all = np.ones(lon.shape, bool)
    for f, x in zip(fovs, xis):
        valid_all &= project(lon, lat, f, x)[2]
    # largest centred rectangle inside the region covered by every frame
    cy, cx = half_h, half_w
    col_h = np.zeros(lon.shape[1], int)
    for j in range(lon.shape[1]):
        up = valid_all[:cy + 1, j][::-1]
        down = valid_all[cy:, j]
        col_h[j] = min(np.argmin(np.append(up, False)), np.argmin(np.append(down, False)))
    best = (0, 0, 0)
    run_min = 10 ** 9
    for a in range(0, half_w + 1):
        run_min = min(run_min, col_h[cx - a], col_h[cx + a])
        b = run_min - 1
        if b < 0:
            break
        area = (2 * a + 1) * (2 * b + 1)
        if area > best[0]:
            best = (area, a, b)
    _, a, b = best
    crop = (lon[cy - b:cy + b, cx - a:cx + a], lat[cy - b:cy + b, cx - a:cx + a])   # even sizes, inside the rect
    full = (lon[: 2 * half_h, : 2 * half_w], lat[: 2 * half_h, : 2 * half_w])
    return {"full": full, "crop": crop}, ppr


def encode(frames, dst, poster):
    h, w = frames.shape[1:3]
    cmd = [FF, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
           "-framerate", "16", "-i", "pipe:", "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt",
           "yuv420p", "-movflags", "+faststart", "-an", str(dst)]
    subprocess.run(cmd, input=np.ascontiguousarray(frames).tobytes(), check=True)
    iio.imwrite(poster, frames[0], quality=80)


samples = {s["name"]: s for s in json.load(open(repo / "demo" / "lens_showcase.json"))}
layout_file = root / "tools" / "erp_layout.json"                  # merged, so scenes can run in parallel
summary = json.loads(layout_file.read_text()) if layout_file.exists() else {}
for scene in sorted(samples):
    if only and scene not in only:
        continue
    fovs, xis = lens_schedule(samples[scene])
    views, ppr = layout(fovs, xis)
    maps = {}
    for k, (lon, lat) in views.items():
        cache = {}                                           # constant lenses share one map
        for f, x in zip(fovs, xis):
            key = (round(float(f), 6), round(float(x), 6))
            if key not in cache:
                cache[key] = project(lon, lat, f, x)[:2]
            maps.setdefault(k, []).append(cache[key])
    summary[scene] = {k: [int(v[0].shape[1]), int(v[0].shape[0])] for k, v in views.items()}
    summary[scene]["deg_per_px"] = round(float(np.rad2deg(1 / ppr)), 4)
    for src in sorted((root / "_source_videos" / scene).glob("*_seed*.mp4")):
        if "_erp_" in src.stem:
            continue
        video = None
        for kind, kmaps in maps.items():
            dst = root / "static" / "videos" / scene / f"{src.stem}_erp_{kind}.mp4"
            poster = root / "static" / "posters" / scene / f"{src.stem}_erp_{kind}.jpg"
            if dst.exists() and poster.exists():
                continue
            if video is None:
                video = iio.imread(src)
                assert video.shape[0] == T and video.shape[1:3] == (H, W), (src, video.shape)
            out = np.stack([cv2.remap(video[t], mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
                            for t, (mx, my) in enumerate(kmaps)])
            dst.parent.mkdir(parents=True, exist_ok=True)
            poster.parent.mkdir(parents=True, exist_ok=True)
            encode(out, dst, poster)
            print(dst.relative_to(root), out.shape[2], "x", out.shape[1], dst.stat().st_size // 1024, "KB", flush=True)
layout_file.write_text(json.dumps(dict(sorted(summary.items())), indent=1))
