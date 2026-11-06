#!/usr/bin/env python
"""Camera-control comparison: recover the camera of showcase videos with ViPE and compare it with the request.

Same protocol as the paper's pose evaluation (original ``src/evaluate.py``: ``vipe`` + ``pose``):

1. ``rectify``: undistort each generated UCM video (CRePE and UCPE, every scene and seed) to a pinhole video
   with the lens it was generated for (horizontal FoV capped at 100 deg, vertical extent from the centre column
   x 0.98, square pixels).
2. run ViPE on the rectified videos, from ViPE's repository (https://github.com/nv-tlabs/vipe):

       python run.py pipeline=default streams=raw_mp4_stream streams.base_path=<work>/rectified \\
           pipeline.output.path=<work>/vipe pipeline.output.save_artifacts=true \\
           pipeline.output.save_viz=false pipeline.post.depth_align_model=null

3. ``collect``: for the examples in ``tools/camera_compare.json`` (lens showcase) and, first, the zero-shot RealCam-Vid
   examples prepared by ``tools/prepare_realcam.py``, requested and ViPE camera-to-world poses ->
   relative to frame 0, translations divided by their maximum norm; per-frame rotation / translation errors and
   CamMC; writes ``static/js/camera-data.js``. The ViPE poses used are copied to ``tools/vipe_poses/`` so the page
   data can be rebuilt without the work directory (``collect`` without a work dir reads them from there).

    python tools/vipe_tracks.py rectify <CRePE repo> <work dir>
    python tools/vipe_tracks.py collect <CRePE repo> [<work dir>]
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

root = Path(__file__).resolve().parents[1]
MODELS = ("crepe", "ucpe")
SEEDS = (0, 1, 2)
T, H, W = 81, 480, 832


def setup(repo):
    sys.path.insert(0, str(repo))
    samples = {s["name"]: s for s in json.load(open(repo / "demo" / "lens_showcase.json"))}
    return samples


def rectify_maps(x_fov, xi, max_xfov=100.0):
    """Port of the paper's ``rectify_ucm_to_pinhole`` (grid for ``F.grid_sample``)."""
    import torch
    from crepe.geometry import ucm_project, ucm_ray_grid
    theta_x = np.deg2rad(min(x_fov / 2, max_xfov / 2))
    d = ucm_ray_grid(float(x_fov), float(xi), H, W).reshape(H, W, 3)
    col = d[:, W // 2, :]
    theta_y = torch.atan2(col[:, 1].abs(), col[:, 2].clamp(min=1e-8))
    theta_y_eff = float(torch.nanquantile(theta_y, 1.0) if torch.isnan(theta_y).any() else theta_y.max()) * 0.98
    f = max((W * 0.5) / np.tan(theta_x), (H * 0.5) / np.tan(theta_y_eff))
    cx, cy = (W - 1) * 0.5, (H - 1) * 0.5
    uu, vv = torch.meshgrid(torch.arange(W, dtype=torch.float32), torch.arange(H, dtype=torch.float32), indexing="xy")
    X, Y = (uu - cx) / f, (vv - cy) / f
    du, dv = ucm_project(X, Y, torch.ones_like(X), float(x_fov), float(xi), H, W)
    du, dv = du.reshape(H, W), dv.reshape(H, W)
    grid = torch.stack([2.0 * du / (W - 1) - 1.0, 2.0 * dv / (H - 1) - 1.0], -1)
    return grid, f


def rectify(repo, work):
    import imageio.v3 as iio
    import imageio_ffmpeg
    import torch
    import torch.nn.functional as F
    samples = setup(repo)
    from crepe import resolve_lens_value
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    out = work / "rectified"
    out.mkdir(parents=True, exist_ok=True)
    for scene, s in samples.items():
        fovs = np.broadcast_to(resolve_lens_value(s["x_fov"], s.get("x_fov_schedule"), T), (T,))
        xis = np.broadcast_to(resolve_lens_value(s["xi"], s.get("xi_schedule"), T), (T,))
        cache, grids = {}, []
        for f_, x_ in zip(fovs, xis):
            key = (round(float(f_), 5), round(float(x_), 5))
            if key not in cache:
                cache[key] = rectify_maps(*key)
            grids.append(cache[key][0])
        for model in MODELS:
            for seed in SEEDS:
                src = root / "_source_videos" / scene / f"{model}_seed{seed}.mp4"
                dst = out / f"{scene}__{model}__seed{seed}.mp4"
                if dst.exists() or not src.exists():
                    continue
                video = torch.from_numpy(iio.imread(src)).permute(0, 3, 1, 2).float() / 255.0
                rect = torch.cat([F.grid_sample(video[t:t + 1], grids[t][None], mode="bilinear", align_corners=False)
                                  for t in range(T)]).clamp(0, 1)
                frames = (rect * 255).byte().permute(0, 2, 3, 1).contiguous().numpy()
                cmd = [ff, "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                       "-framerate", "16", "-i", "pipe:", "-pix_fmt", "yuv420p", "-vcodec", "libx264", "-crf", "16",
                       "-preset", "slow", str(dst)]
                subprocess.run(cmd, input=frames.tobytes(), check=True)
                print(dst.name, flush=True)


def relative_normalized(c2w):
    rel = np.linalg.inv(c2w[0])[None] @ c2w
    scale = np.max(np.linalg.norm(rel[:, :3, 3], axis=-1)) + 1e-9
    rel[:, :3, 3] /= scale
    return rel


def run_metrics(gt, pred):
    rot = np.degrees(np.arccos(np.clip((np.trace(np.transpose(gt[:, :3, :3], (0, 2, 1)) @ pred[:, :3, :3],
                                                 axis1=-2, axis2=-1) - 1) / 2, -1, 1)))
    trans = np.linalg.norm(gt[:, :3, 3] - pred[:, :3, 3], axis=-1)
    cammc = np.linalg.norm((pred[:, :3, :4] - gt[:, :3, :4]).reshape(T, -1), axis=-1)
    return {"rot_err_deg": round(float(rot.mean()), 2), "trans_err": round(float(trans.mean()), 3),
            "cammc": round(float(cammc[::4].sum()), 2)}


def realcam_entries():
    """Zero-shot RealCam-Vid examples (tools/prepare_realcam.py): requested trajectory + ViPE poses of both models."""
    cams_file = root / "tools" / "realcam_cameras.json"
    if not cams_file.exists():
        return []
    cams = json.load(open(cams_file))
    out = []
    for ex in json.load(open(root / "tools" / "realcam_examples.json")):
        c = cams[str(ex["idx"])]
        req = np.concatenate([np.asarray(c["pose"], dtype=np.float64).reshape(T, 3, 4),
                              np.tile([[[0, 0, 0, 1.0]]], (T, 1, 1))], 1)
        gt = relative_normalized(req)
        entry = {"kind": "realcam", "id": f"realcam_{ex['idx']}", "title": c["title"], "caption": c["caption"],
                 "source": c["source"], "x_fov": c["x_fov"], "turn_deg": c["turn_deg"], "travel_m": c["travel_m"],
                 "requested": track(gt), "runs": {}}
        for model in MODELS:
            pred = relative_normalized(np.load(root / "tools" / "vipe_poses" / f"realcam_{ex['idx']}__{model}.npz")["data"]
                                       .astype(np.float64)[:T])
            entry["runs"][model] = dict(track(pred), metrics=run_metrics(gt, pred))
        out.append(entry)
        print("realcam", ex["idx"], {m: r["metrics"] for m, r in entry["runs"].items()})
    return out


def track(c2w):
    """Positions + camera axes (OpenCV: x right, y down, z forward) rounded for the page."""
    r = lambda a: np.round(a, 4).tolist()
    return {"pos": r(c2w[:, :3, 3]), "fwd": r(c2w[:, :3, 2]), "up": r(-c2w[:, :3, 1])}


def collect(repo, work=None):
    samples = setup(repo)
    from crepe import load_trajectory
    poses = root / "tools" / "vipe_poses"
    poses.mkdir(exist_ok=True)
    out = []
    for ex in json.load(open(root / "tools" / "camera_compare.json")):
        scene, seed, s = ex["scene"], ex["seed"], samples[ex["scene"]]
        traj = s["trajectory"] if Path(s["trajectory"]).is_absolute() else str(repo / s["trajectory"])
        req = np.asarray(load_trajectory(traj, num_frames=T), dtype=np.float64)[:, :3, :4]
        gt = relative_normalized(np.concatenate([req, np.tile([[[0, 0, 0, 1.0]]], (T, 1, 1))], 1))
        entry = {"kind": "showcase", "scene": scene, "seed": seed, "requested": track(gt), "runs": {}}
        for model in MODELS:
            name = f"{scene}__{model}__seed{seed}.npz"
            hits = sorted(work.glob(f"vipe*/pose/{name}")) if work else []     # ViPE shards
            if hits:
                shutil.copyfile(hits[0], poses / name)
            pred = relative_normalized(np.load(poses / name)["data"].astype(np.float64)[:T])
            rot = np.degrees(np.arccos(np.clip((np.trace(np.transpose(gt[:, :3, :3], (0, 2, 1)) @ pred[:, :3, :3],
                                                         axis1=-2, axis2=-1) - 1) / 2, -1, 1)))
            trans = np.linalg.norm(gt[:, :3, 3] - pred[:, :3, 3], axis=-1)
            cammc = np.linalg.norm((pred[:, :3, :4] - gt[:, :3, :4]).reshape(T, -1), axis=-1)
            entry["runs"][model] = dict(track(pred), metrics={
                "rot_err_deg": round(float(rot.mean()), 2),          # mean over frames
                "trans_err": round(float(trans.mean()), 3),
                "cammc": round(float(cammc[::4].sum()), 2)})        # the paper's tables: frame stride 4, summed
        out.append(entry)
        print(scene, seed, {m: r["metrics"] for m, r in entry["runs"].items()})
    out = realcam_entries() + out
    js = "// Generated by tools/vipe_tracks.py. Do not edit by hand.\nwindow.CREPE_CAMERA = " + \
         json.dumps(out, separators=(",", ":")) + ";\n"
    (root / "static" / "js" / "camera-data.js").write_text(js)


if __name__ == "__main__":
    cmd, repo = sys.argv[1], Path(sys.argv[2])
    work = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    if cmd == "rectify":
        rectify(repo, work)
    else:
        collect(repo, work)
