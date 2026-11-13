"""Export part of a .blend as one web GLB (props, a plinth set, a baked hall), with an optional check render.

    blender --background --python blender/export_scene.py -- --config scene.json

Generalised from the export steps of The Forge's scripts/export_web.py (baked hall -> GLB with WebP textures) and
Rapture Chess's scripts/build-set.py (Draco with a plain fallback, then a check render). Baking itself stays
scene-specific: bake in your own script, then export the baked objects with this one. Never saves the .blend.

Config (paths relative to this file):
  blend          the .blend to open (omitted: the file Blender was started with)
  out            the GLB to write                                                           (required)
  collection     export only this collection's objects
  prefixes       ...and/or objects whose names start with one of these, e.g. ["BK_", "FX_"]
  objects        ...and/or these objects by name, e.g. ["Cam_Hall"]
  draco          false | true | { "level": 6, "position": 14, "normal": 10, "texcoord": 12 }
  images         WEBP | JPEG | AUTO | NONE (default WEBP), image_quality (default 88)
  cameras        export cameras (default false); extras: custom properties (default true)
  check_render   { "out": "check.png", "resolution": [1280, 800], "camera": "Cam" }: a quick look at the result
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402


def pick(bpy, cfg):
    chosen = set()
    if cfg.get("collection"):
        coll = bpy.data.collections.get(cfg["collection"])
        if not coll:
            raise H.ConfigError(f'no collection "{cfg["collection"]}" in this file')
        chosen |= set(coll.all_objects)
    prefixes = tuple(cfg.get("prefixes") or ())
    if prefixes:
        chosen |= {o for o in bpy.data.objects if o.name.startswith(prefixes)}
    for name in cfg.get("objects") or ():
        o = bpy.data.objects.get(name)
        if not o:
            raise H.ConfigError(f'no object "{name}" in this file')
        chosen.add(o)
    if not (cfg.get("collection") or prefixes or cfg.get("objects")):
        chosen = set(bpy.context.scene.objects)
    return chosen


def main():
    import bpy

    args = H.parse_args()
    cfg = H.load_config(args["config"], required=("out",))
    if cfg.get("blend"):
        bpy.ops.wm.open_mainfile(filepath=H.resolve(cfg, cfg["blend"]))
    chosen = pick(bpy, cfg)
    out = H.resolve(cfg, cfg["out"])
    H.log(f"exporting {len(chosen)} objects -> {out}")
    if args["dry_run"]:
        for o in sorted(chosen, key=lambda o: o.name):
            H.log("  ", o.name)
        return
    vl = bpy.context.view_layer
    for o in vl.objects:
        o.select_set(o in chosen)
    how = H.export_glb(
        out, draco=cfg.get("draco", False), use_selection=True,
        export_image_format=cfg.get("images", "WEBP"), export_image_quality=int(cfg.get("image_quality", 88)),
        export_cameras=bool(cfg.get("cameras", False)), export_lights=False, export_apply=True,
        export_extras=bool(cfg.get("extras", True)), export_yup=True, export_animations=bool(cfg.get("animations", False)),
    )
    H.log(f"EXPORTED {out} ({os.path.getsize(out) / 1e6:.2f} MB, {how}) sha256 {H.sha256_file(out)}")

    check = cfg.get("check_render")
    if check:
        scene = bpy.context.scene
        if check.get("camera"):
            scene.camera = bpy.data.objects[check["camera"]]
        if scene.camera is None:
            raise H.ConfigError("check_render: the scene has no camera; name one with check_render.camera")
        H.set_engine(scene, check.get("engine") or ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH"])
        w, h = check.get("resolution", [1280, 800])
        scene.render.resolution_x, scene.render.resolution_y = int(w), int(h)
        scene.render.filepath = H.resolve(cfg, check["out"])
        bpy.ops.render.render(write_still=True)
        H.log("RENDER", scene.render.filepath)


if __name__ == "__main__":
    try:
        main()
    except H.ConfigError as e:
        H.fail(e)
