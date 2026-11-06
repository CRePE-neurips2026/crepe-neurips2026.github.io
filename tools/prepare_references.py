#!/usr/bin/env python
"""Reference clips for the lens showcase: the dataset clip each camera trajectory was taken from.

    python tools/prepare_references.py <PanShot videos-test dir>

For every PanShot trajectory used in tools/lens_showcase.json (``panshot_<clip>.npy``) this looks up
``<clip>-fov<F>-xi<X>.mp4`` in the PanShot test split (81 frames, 16 fps, 832 x 480, i.e. frame-aligned with
the generated videos) and writes

* the original          -> _source_videos/reference/<clip>.mp4   (git-ignored)
* a web encode          -> static/videos/reference/<clip>.mp4    (H.264, CRF 24, faststart)
* a poster frame        -> static/posters/reference/<clip>.jpg
* tools/references.json -> {trajectory stem: {clip, fov, xi, source}} (read by tools/build_data.py)

RealEstate10K trajectories have no local video (the dataset only links YouTube videos) and are skipped.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
src_dir = Path(sys.argv[1])
root = Path(__file__).resolve().parents[1]
refs = {}
for item in json.load(open(root / "tools" / "lens_showcase.json")):
    stem = Path(item["trajectory"]).stem
    if not stem.startswith("panshot_") or stem in refs:
        continue
    clip = stem[len("panshot_"):]
    hits = sorted(src_dir.glob(f"{clip}-fov*-xi*.mp4"))
    if len(hits) != 1:
        print("no unique PanShot clip for", stem, hits)
        continue
    fov, xi = map(float, re.search(r"-fov([\d.]+)-xi([\d.]+)\.mp4$", hits[0].name).groups())
    orig = root / "_source_videos" / "reference" / f"{clip}.mp4"
    web = root / "static" / "videos" / "reference" / f"{clip}.mp4"
    poster = root / "static" / "posters" / "reference" / f"{clip}.jpg"
    for p in (orig, web, poster):
        p.parent.mkdir(parents=True, exist_ok=True)
    if not orig.exists():
        shutil.copyfile(hits[0], orig)
    if not web.exists():
        subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", str(orig), "-c:v", "libx264",
                        "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                        "-an", str(web)], check=True)
    if not poster.exists():
        subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", str(orig), "-vf", "select=eq(n\\,0)",
                        "-frames:v", "1", "-q:v", "4", str(poster)], check=True)
    refs[stem] = {"clip": clip, "fov": fov, "xi": xi, "source": f"PanShot test split ({hits[0].name})"}
    print(web.relative_to(root), web.stat().st_size // 1024, "KB", f"FoV {fov:g}, xi {xi:g}")
(root / "tools" / "references.json").write_text(json.dumps(refs, indent=1) + "\n")
