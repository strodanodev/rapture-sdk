"""Key art off a black or green background into transparent, cropped WebPs (logos, wordmarks, card cut-outs).

    blender --background --python blender/key_alpha.py -- --config key.json

Generalised from The Forge's scripts/title_assets.py, using only what Blender ships (numpy and its image I/O), so
the harness needs no Pillow:
  black   chrome on black: alpha >= max(r, g, b) reproduces the original exactly over black, so alpha is that floor,
          raised to 1 inside the lit shape (dark reflections stay solid over a bright page)
  green   art on a green screen: alpha from how green a pixel is next to the screen colour (the median of the border),
          the screen un-mixed from edge pixels, then despilled

Config (paths relative to this file):
  items: [ { "src": "logo.jpg", "out": "logo.webp", "mode": "black" | "green", "width": 900, "pad": 12, "quality": 90 } ]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402


def box_max(np, a, r):
    """Max filter over a (2r+1) square (PIL's MaxFilter)."""
    p = np.pad(a, r, mode="edge")
    out = np.full_like(a, -np.inf)
    for dy in range(2 * r + 1):
        for dx in range(2 * r + 1):
            out = np.maximum(out, p[dy:dy + a.shape[0], dx:dx + a.shape[1]])
    return out


def box_min(np, a, r):
    return -box_max(np, -a, r)


def blur(np, a, sigma):
    r = max(1, int(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    p = np.pad(a, r, mode="edge")
    tmp = sum(k[i] * p[:, i:i + a.shape[1]] for i in range(2 * r + 1))
    return sum(k[i] * tmp[i:i + a.shape[0], :] for i in range(2 * r + 1))


def on_black(np, c):
    floor = c.max(-1)
    lit = (floor > 0.07).astype(np.float32)
    solid = blur(np, box_min(np, box_max(np, lit, 2), 3), 1.2)   # letters' region, gaps closed, edge feathered
    a = np.maximum(floor, np.clip((solid - 0.5) * 2, 0, 1))
    rgb = np.where(a[..., None] > 1e-4, c / np.maximum(a[..., None], 1e-4), 0)
    return np.clip(rgb, 0, 1), a


def on_green(np, c):
    g = c[..., 1] - np.maximum(c[..., 0], c[..., 2])
    border = np.concatenate([c[:20].reshape(-1, 3), c[-20:].reshape(-1, 3), c[:, :20].reshape(-1, 3), c[:, -20:].reshape(-1, 3)])
    screen = np.median(border, 0)
    gs = screen[1] - max(screen[0], screen[2])
    a = np.clip(1 - (g - 0.04) / (gs * 0.82 - 0.04), 0, 1)
    a = np.where(a > 0.985, 1, a)
    rgb = (c - (1 - a[..., None]) * screen) / np.maximum(a[..., None], 1e-4)
    rgb[..., 1] = np.minimum(rgb[..., 1], np.maximum(rgb[..., 0], rgb[..., 2]) + 0.03)
    return np.where(a[..., None] > 1e-3, np.clip(rgb, 0, 1), 0), a


def crop(np, rgba, pad):
    ys, xs = np.nonzero(rgba[..., 3] > 6 / 255)
    if len(ys) == 0:
        raise H.ConfigError("nothing left after keying: check the mode (black or green)")
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad + 1, rgba.shape[0])
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad + 1, rgba.shape[1])
    return rgba[y0:y1, x0:x1]


def main():
    import bpy
    import numpy as np

    args = H.parse_args()
    cfg = H.load_config(args["config"], required=("items",))
    for item in cfg["items"]:
        src, dst = H.resolve(cfg, item["src"]), H.resolve(cfg, item["out"])
        mode = item.get("mode", "black")
        if mode not in ("black", "green"):
            raise H.ConfigError(f"{src}: mode must be black or green")
        if args["dry_run"]:
            H.log("would key", src, "->", dst)
            continue
        img = bpy.data.images.load(src)
        img.colorspace_settings.name = "Non-Color"   # work on the stored values, as Pillow does
        w, h = img.size
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
        bpy.data.images.remove(img)
        c = px.reshape(h, w, 4)[..., :3]
        rgb, a = (on_black if mode == "black" else on_green)(np, c)
        rgba = crop(np, np.dstack([rgb, a]).astype(np.float32), int(item.get("pad", 12)))
        oh, ow = rgba.shape[:2]
        out = bpy.data.images.new("keyed", ow, oh, alpha=True)
        out.colorspace_settings.name = "Non-Color"
        out.alpha_mode = "STRAIGHT"
        out.pixels.foreach_set(np.ascontiguousarray(rgba).ravel())
        width = int(item.get("width", 0))
        if width and ow > width:
            out.scale(width, round(oh * width / ow))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        out.filepath_raw = dst
        out.file_format = "WEBP" if dst.lower().endswith(".webp") else "PNG"
        if hasattr(out, "quality"):
            out.quality = int(item.get("quality", 90))
        out.save()
        H.log(f"keyed {os.path.basename(dst)}: {out.size[0]}x{out.size[1]}, {os.path.getsize(dst) / 1024:.0f} KB")
        bpy.data.images.remove(out)


if __name__ == "__main__":
    try:
        main()
    except H.ConfigError as e:
        H.fail(e)
