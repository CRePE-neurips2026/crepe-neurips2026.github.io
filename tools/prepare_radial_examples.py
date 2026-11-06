#!/usr/bin/env python
"""Build the camera + radial-map examples of the page from prepared samples and CRePE-Mix outputs.

    python tools/prepare_radial_examples.py <CRePE repo> [<outputs subfolder, default radial_v2>]

Reads ``<repo>/samples/**/<name>/{clip/<name>.mp4, radial.pth}`` and
``<repo>/outputs/<subfolder>/<name>__{gen,transfer}/seed0.mp4`` (generated with the paper setting: teacher sigma 0.1,
no calibration; gen = from noise, transfer = from the source video noised to 75%); writes full-quality copies to
``_source_videos/radial/<name>/`` (git-ignored), web encodes + posters to ``static/{videos,posters}/radial/<name>/``
and the gallery data to ``static/js/radial-data.js``.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import imageio
import imageio_ffmpeg
import numpy as np
import torch
from matplotlib import colormaps
from PIL import Image

FF = imageio_ffmpeg.get_ffmpeg_exe()
root = Path(__file__).resolve().parents[1]
repo = Path(sys.argv[1])
out_root = repo / "outputs" / (sys.argv[2] if len(sys.argv) > 2 else "radial_v2")
cfg = json.load(open(root / "tools" / "radial_examples.json"))
prompts = json.load(open(repo / "demo" / "radial_prompts.json"))


def encode(src, dst, poster):
    dst.parent.mkdir(parents=True, exist_ok=True); poster.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-c:v", "libx264", "-preset", "slow",
                    "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(dst)], check=True)
    subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vf", "select=eq(n\\,0)",
                    "-frames:v", "1", "-q:v", "4", str(poster)], check=True)


def render_radial(radial_path, out_path, duration, width=832, height=480):
    """Colourise a (T, h, w) distance map: inverse distance, robust per-video scaling, jet, black = invalid."""
    r = torch.load(radial_path, map_location="cpu")
    d = r["distance"].float().numpy()
    valid = r["valid"].float().numpy() > 0.5 if r.get("valid") is not None else np.isfinite(d)
    valid &= np.isfinite(d) & (d > 0)
    inv = np.where(valid, 1.0 / np.where(valid, d, 1.0), np.nan)
    lo, hi = np.nanpercentile(inv, 2), np.nanpercentile(inv, 98)
    norm = np.clip((inv - lo) / max(hi - lo, 1e-6), 0, 1)
    rgb = (colormaps["jet"](np.nan_to_num(norm))[..., :3] * 255).astype(np.uint8)
    rgb[~valid] = 0
    frames = [np.asarray(Image.fromarray(f).resize((width, height), Image.NEAREST)) for f in rgb]
    writer = imageio.get_writer(str(out_path), fps=len(frames) / duration, quality=9, macro_block_size=16)
    for f in frames:
        writer.append_data(f)
    writer.close()


entries = []
for ex in cfg:
    name, eid = ex["sample"], ex["id"]
    out_name = ex.get("output", name)        # output folder prefix (differs when the prompt is not the default)
    if not any((out_root / f"{out_name}__{m}" / "seed0.mp4").exists() for m in ("gen", "transfer")):
        print(f"skip {eid}: no generated video yet")
        continue
    # rebuild this example from scratch so modes dropped from the config leave no stale files behind
    for stale in (root / "_source_videos" / "radial" / eid, root / "static/videos/radial" / eid,
                  root / "static/posters/radial" / eid):
        shutil.rmtree(stale, ignore_errors=True)
    src_dir = root / "_source_videos" / "radial" / eid
    src_dir.mkdir(parents=True, exist_ok=True)
    sample_dir = next(p.parent for p in repo.glob(f"samples/**/{name}/sample.json"))
    clip = sample_dir / "clip" / f"{name}.mp4"
    shutil.copyfile(clip, src_dir / "reference.mp4")
    reader = imageio.get_reader(str(clip)); meta = reader.get_meta_data(); n = reader.count_frames(); reader.close()
    duration = n / meta["fps"]
    render_radial(sample_dir / "radial.pth", src_dir / "radial_map.mp4", duration)
    modes = []
    for mode in ex.get("modes", ("gen", "transfer")):  # per-example list drops modes that failed review
        out = out_root / f"{out_name}__{mode}" / "seed0.mp4"
        if out.exists():
            shutil.copyfile(out, src_dir / f"{mode}.mp4")
            modes.append(mode)
    for key in ["reference", "radial_map"] + modes:
        encode(src_dir / f"{key}.mp4", root / "static/videos/radial" / eid / f"{key}.mp4",
               root / "static/posters/radial" / eid / f"{key}.jpg")
    cam = np.load(sample_dir / "camera.npz")
    entries.append({"id": eid, "title": ex["title"], "group": ex["group"], "source": ex["source"],
                    "prompt": ex.get("prompt", prompts.get(name, "")), "modes": modes, "fov": round(float(cam["x_fov"]), 1),
                    "xi": round(float(cam["xi"]), 2)})
    print(eid, modes)
for ex in json.load(open(root / "tools" / "radial_paper_examples.json")):
    prompt = (root / "_source_videos" / "radial" / ex["id"] / "prompt.txt").read_text().strip()
    entries.append(dict(ex, prompt=prompt, modes=["transfer"]))
js = "// Generated by tools/prepare_radial_examples.py. Do not edit by hand.\nwindow.CREPE_RADIAL = " + json.dumps(entries, indent=1, ensure_ascii=False) + ";\n"
(root / "static/js/radial-data.js").write_text(js)
