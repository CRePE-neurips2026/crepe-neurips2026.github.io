#!/usr/bin/env python
"""Copy generated showcase videos into the page and build web versions.

    python tools/prepare_videos.py <model> <output_dir>

<output_dir>/<scene>/seed<k>.mp4 are the videos of one model (``crepe`` or ``ucpe``) for the samples of
``demo/lens_showcase.json`` of the code repository.

* full-quality originals -> _source_videos/<scene>/<model>_seed<k>.mp4  (git-ignored)
* web encodes            -> static/videos/<scene>/<model>_seed<k>.mp4   (H.264, CRF 24, faststart)
* poster frames          -> static/posters/<scene>/<model>_seed<k>.jpg
"""
import shutil
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg

FF = imageio_ffmpeg.get_ffmpeg_exe()
model, src_root = sys.argv[1], Path(sys.argv[2])
assert model in ("crepe", "ucpe"), model
root = Path(__file__).resolve().parents[1]
for scene_dir in sorted(p for p in src_root.iterdir() if p.is_dir() and p.name[:2].isdigit()):
    for src in sorted(scene_dir.glob("seed*.mp4")):
        name = f"{model}_{src.name}"
        orig = root / "_source_videos" / scene_dir.name / name
        web = root / "static" / "videos" / scene_dir.name / name
        poster = root / "static" / "posters" / scene_dir.name / name.replace(".mp4", ".jpg")
        for p in (orig, web, poster):
            p.parent.mkdir(parents=True, exist_ok=True)
        if not orig.exists():
            shutil.copyfile(src.resolve(), orig)
        if not web.exists():
            subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", str(orig), "-c:v", "libx264",
                            "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                            "-an", str(web)], check=True)
        if not poster.exists():
            subprocess.run([FF, "-hide_banner", "-loglevel", "error", "-y", "-i", str(orig), "-vf", "select=eq(n\\,0)",
                            "-frames:v", "1", "-q:v", "4", str(poster)], check=True)
        print(web.relative_to(root), web.stat().st_size // 1024, "KB", flush=True)
