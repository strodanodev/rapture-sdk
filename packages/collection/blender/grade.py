"""Grade linear HDR renders or bakes into display images, through Blender's own colour management.

    blender --background --python blender/grade.py -- --config grade.json

Generalised from The Forge's scripts/grade_cinematic.py: a small grade in scene-linear (exposure, white balance,
saturation, contrast around 18% grey, shadow lift), then Blender's view transform and look (AgX, "AgX - Punchy",
Filmic, Standard ...), so a neutral grade reproduces what Blender would have written and a change takes seconds
instead of a re-render. Inputs: .exr / .hdr (any float image Blender reads) and .npz arrays (key `npz_key`, rows
top-down, as export_web.py's bakes are stored).

Config (paths relative to this file):
  inputs        a glob, e.g. "renders/*.exr" or "bake/BK_*_hdr.npz"                         (required)
  out           output folder                                                               (required)
  format        PNG | WEBP (default PNG), quality (WebP, default 90)
  view          view transform (default AgX), look (default None), display (default sRGB)
  grade         { "exposure": 0, "white_balance": [1, 1, 1], "saturation": 1, "contrast": 1, "shadow_lift": 0 }
  npz_key       the array in an .npz (default "hdr"); npz_flip: rows stored top-down (default true)
"""
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

NEUTRAL = {"exposure": 0.0, "white_balance": [1.0, 1.0, 1.0], "saturation": 1.0, "contrast": 1.0, "shadow_lift": 0.0}
LUMA = (0.2126, 0.7152, 0.0722)


def grade(np, rgb, g):
    """The grade, in scene-linear; neutral settings return the input unchanged."""
    x = rgb * (2.0 ** g["exposure"]) * np.asarray(g["white_balance"], dtype=np.float32)
    y = (x @ np.asarray(LUMA, dtype=np.float32))[..., None]
    x = y + (x - y) * g["saturation"]
    if g["contrast"] != 1.0:
        x = 0.18 * np.power(np.maximum(x, 0) / 0.18, g["contrast"])
    return x + g["shadow_lift"]


def read_linear(bpy, np, path, cfg):
    """(H, W, 4) float32, rows bottom-up as Blender stores them."""
    if path.lower().endswith(".npz"):
        a = np.load(path)[cfg.get("npz_key", "hdr")].astype(np.float32)
        if cfg.get("npz_flip", True):
            a = a[::-1]
        if a.shape[-1] == 3:
            a = np.concatenate([a, np.ones(a.shape[:2] + (1,), np.float32)], -1)
        return np.ascontiguousarray(a)
    img = bpy.data.images.load(path)   # float images (EXR, HDR) load as scene-linear, which pixels returns
    if not img.is_float:
        raise H.ConfigError(f"{path}: not a float image (grade linear EXR, HDR or .npz renders)")
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def main():
    import bpy
    import numpy as np

    args = H.parse_args()
    cfg = H.load_config(args["config"], required=("inputs", "out"))
    files = sorted(glob.glob(H.resolve(cfg, cfg["inputs"])))
    if not files:
        raise H.ConfigError(f"no files match {cfg['inputs']}")
    out = H.resolve(cfg, cfg["out"])
    os.makedirs(out, exist_ok=True)
    g = {**NEUTRAL, **cfg.get("grade", {})}
    fmt = str(cfg.get("format", "PNG")).upper()
    if args["dry_run"]:
        for f in files:
            H.log("would grade", f)
        return

    scene = bpy.context.scene
    scene.display_settings.display_device = cfg.get("display", "sRGB")
    try:
        scene.view_settings.view_transform = cfg.get("view", "AgX")
        scene.view_settings.look = cfg.get("look", "None")
    except TypeError as e:  # the message lists the valid names for this Blender
        raise H.ConfigError(f"view/look: {e}") from e
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.render.image_settings.file_format = fmt
    scene.render.image_settings.color_mode = "RGB"
    if fmt == "WEBP":
        scene.render.image_settings.quality = int(cfg.get("quality", 90))

    for f in files:
        lin = read_linear(bpy, np, f, cfg)
        lin[..., :3] = grade(np, lin[..., :3], g)
        h, w = lin.shape[:2]
        img = bpy.data.images.new("graded", w, h, alpha=True, float_buffer=True)
        img.pixels.foreach_set(lin.ravel())
        name = os.path.basename(f).split(".")[0]
        dst = os.path.join(out, f"{name}.{'webp' if fmt == 'WEBP' else 'png'}")
        img.save_render(dst, scene=scene)   # applies the view transform and look
        bpy.data.images.remove(img)
        H.log("graded", dst)


if __name__ == "__main__":
    try:
        main()
    except H.ConfigError as e:
        H.fail(e)
