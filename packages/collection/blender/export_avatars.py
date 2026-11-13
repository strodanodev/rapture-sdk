"""Re-export champion avatars as game-ready GLBs: keep the clips a game plays, drop helper objects, compress with Draco.

    blender --background --python blender/export_avatars.py -- --config avatars.json [--only aurexe,bramweld]

Generalised from Rapture Chess's scripts/export-avatars.py (a 750 KB meshopt avatar comes out around 450 KB). For each
<slug>.glb (or .gltf, .fbx) under `src`, writes <out>/<slug>.glb and, when `plain` is set, an uncompressed core-glTF
twin under <plain>/<slug>.glb for loaders without a Draco decoder: the token's `avatar` and `avatarPlain`. Also writes
<out>/avatars.json with each file's sha256 (what the metadata pipeline hashes, and what the token's design records).

Config (paths relative to this file):
  src            folder of source avatars                                                   (required)
  out            output folder                                                              (required)
  plain          folder for the uncompressed twins (omitted: none)
  keep_clips     animation names to keep (omitted: all), e.g. ["idle", "attack", "hit", "death"]
  drop_objects   object names to delete before export, e.g. ["Icosphere"]
  draco          false | true | { "level": 6, "position": 12, "normal": 8, "texcoord": 10 }
  images         NONE | AUTO | WEBP | JPEG (default AUTO: textures embedded as they are)
"""
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

IMPORTERS = {".glb": "gltf", ".gltf": "gltf", ".fbx": "fbx"}


def load(bpy, path):
    kind = IMPORTERS[os.path.splitext(path)[1].lower()]
    if kind == "gltf":
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        bpy.ops.import_scene.fbx(filepath=path)


def main():
    import bpy

    args = H.parse_args()
    cfg = H.load_config(args["config"], required=("src", "out"))
    src, out, plain = H.resolve(cfg, cfg["src"]), H.resolve(cfg, cfg["out"]), H.resolve(cfg, cfg.get("plain"))
    keep = set(cfg.get("keep_clips") or [])
    drop = set(cfg.get("drop_objects") or [])
    draco = cfg.get("draco", {"level": 6, "position": 12, "normal": 8, "texcoord": 10})
    images = cfg.get("images", "AUTO")
    files = sorted(p for p in glob.glob(os.path.join(src, "*")) if os.path.splitext(p)[1].lower() in IMPORTERS)
    files = [p for p in files if not args["only"] or os.path.splitext(os.path.basename(p))[0] in args["only"]]
    if not files:
        raise H.ConfigError(f"no .glb, .gltf or .fbx avatars in {src}")
    if args["dry_run"]:
        for p in files:
            H.log("would export", p)
        return

    manifest = {}
    for path in files:
        slug = os.path.splitext(os.path.basename(path))[0]
        H.empty_scene()
        load(bpy, path)
        if keep:
            for a in list(bpy.data.actions):
                if a.name not in keep:
                    bpy.data.actions.remove(a)
        for name in drop:
            o = bpy.data.objects.get(name)
            if o:
                bpy.data.objects.remove(o, do_unlink=True)
        kw = dict(export_animations=True, export_apply=True, export_skins=True, export_yup=True, export_image_format=images)
        dst = os.path.join(out, f"{slug}.glb")
        how = H.export_glb(dst, draco=draco, **kw)
        entry = {"avatar": os.path.relpath(dst, out).replace(os.sep, "/"), "sha256": H.sha256_file(dst), "encoding": how}
        if plain:
            p = os.path.join(plain, f"{slug}.glb")
            H.export_glb(p, draco=None, **kw)
            entry.update(avatarPlain=os.path.relpath(p, out).replace(os.sep, "/"), plainSha256=H.sha256_file(p))
        manifest[slug] = entry
        H.log(f"avatar {slug}: {os.path.getsize(dst) / 1024:.0f} KB ({how})")
    H.write_json(os.path.join(out, "avatars.json"), manifest)


if __name__ == "__main__":
    try:
        main()
    except H.ConfigError as e:
        H.fail(e)
