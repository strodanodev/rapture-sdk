"""Render one card image per token of a collection.

    blender --background --python blender/render_cards.py -- --config cards.json [--only "Ser Brightwall,Old Tamsin"]

A card is a template .blend whose objects are driven by each token's fields (bindings below). Without a template a
plain built-in card is used (a frame coloured by one trait, the name and epithet as text), enough to try the whole
pipeline before there is any art. Writes <out>/<slug>.<ext> and <out>/renders.json (token name -> file, sha256), and
the token's "art" in collection.json then points at its render.

Config (paths relative to this file):
  collection   the collection.json whose tokens to render                                  (required)
  out          output folder                                                               (required)
  template     a .blend to render from; omitted: the built-in card
  camera       camera object name in the template (default: the scene camera)
  engine       ["CYCLES"] or ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"] ... (first available wins)
  gpu          CUDA | OPTIX | HIP | METAL | ONEAPI (Cycles; omitted = CPU)
  samples      render samples (default 64)
  resolution   [width, height] (default [768, 1075], a 5:7 card)
  format       WEBP | PNG (default: the collection's images.ext)
  quality      WebP quality (default 90)
  transparent  film transparency (default false)
  bind:
    text       { "<FONT object>": "<token field>" }               the text body becomes the field's value
    show       { "<object prefix>": "<token field>" }             shows <prefix><value>, hides the prefix's others
    images     { "<image node label or name>": "<token field>" }  the node loads the file the field names
    colors     { "<material>": { "field": "element", "input": "Base Color", "values": { "Fire": [r, g, b] } } }
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H  # noqa: E402

DEFAULT_BIND = {
    "text": {"CardName": "name", "CardEpithet": "epithet"},
    "colors": {"CardFrame": {"field": "element", "input": "Base Color", "values": {}}},
}
PALETTE = [(0.85, 0.55, 0.2), (0.3, 0.55, 0.9), (0.55, 0.8, 0.35), (0.75, 0.3, 0.75), (0.9, 0.85, 0.5), (0.4, 0.4, 0.45)]


def build_default_card(bpy, scene):
    """A 5:7 card: dark body, coloured frame (emissive, so EEVEE and Cycles agree), name and epithet."""
    def mat(name, color, emit=0.0):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        if emit:
            bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
            bsdf.inputs["Emission Strength"].default_value = emit
        return m

    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
    frame = bpy.context.active_object
    frame.name = "CardFrameMesh"
    frame.scale = (5, 7, 1)
    frame.data.materials.append(mat("CardFrame", (0.8, 0.6, 0.25), emit=0.6))
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0.01))
    body = bpy.context.active_object
    body.name = "CardBody"
    body.scale = (4.5, 6.5, 1)
    body.data.materials.append(mat("CardBodyMat", (0.03, 0.03, 0.04)))
    white = mat("CardText", (0.95, 0.93, 0.88), emit=1.0)
    for name, size, y in (("CardName", 0.55, -2.4), ("CardEpithet", 0.28, -2.95)):
        bpy.ops.object.text_add(location=(0, y, 0.02))
        t = bpy.context.active_object
        t.name = name
        t.data.align_x = "CENTER"
        t.data.size = size
        t.data.materials.append(white)
    cam = bpy.data.objects.new("CardCam", bpy.data.cameras.new("CardCam"))
    scene.collection.objects.link(cam)
    cam.location = (0, 0, 10)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 7.2
    scene.camera = cam
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[1].default_value = 1.0


def apply_bindings(bpy, bind, token, col):
    for obj, field in bind.get("text", {}).items():
        o = bpy.data.objects.get(obj)
        if o and o.type == "FONT":
            o.data.body = str(token.get(field) or "")
    for prefix, field in bind.get("show", {}).items():
        want = f"{prefix}{token.get(field)}"
        for o in bpy.data.objects:
            if o.name.startswith(prefix):
                hide = o.name != want
                o.hide_render = hide
                o.hide_viewport = hide
    for label, field in bind.get("images", {}).items():
        path = token.get(field)
        if not path:
            continue
        img = bpy.data.images.load(H.resolve(col, path), check_existing=True)
        for m in bpy.data.materials:
            for n in (m.node_tree.nodes if m.use_nodes else []):
                if n.type == "TEX_IMAGE" and (n.label == label or n.name == label):
                    n.image = img
    trait_values = col.get("traits", {})
    for mname, spec in bind.get("colors", {}).items():
        m = bpy.data.materials.get(mname)
        if not m or not m.use_nodes:
            continue
        value = token.get(spec["field"])
        color = spec.get("values", {}).get(str(value))
        if color is None:  # no colour given: one from the palette, by the value's position in the trait
            names = trait_values.get(spec["field"], {}).get("values", [])
            i = names.index(value) if value in names else (value if isinstance(value, int) else 0)
            color = PALETTE[i % len(PALETTE)]
        node = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if node:
            node.inputs[spec.get("input", "Base Color")].default_value = (*color, 1.0)
            if "Emission Color" in node.inputs and node.inputs["Emission Strength"].default_value > 0:
                node.inputs["Emission Color"].default_value = (*color, 1.0)


def main():
    import bpy

    args = H.parse_args()
    cfg = H.load_config(args["config"], required=("collection", "out"))
    col, tokens = H.collection_tokens(cfg)
    out = H.resolve(cfg, cfg["out"])
    os.makedirs(out, exist_ok=True)
    fmt = str(cfg.get("format") or col.get("images", {}).get("ext", "png")).upper()
    ext = "webp" if fmt == "WEBP" else "png"
    todo = [t for t in tokens if not args["only"] or t.get("name") in args["only"]]
    if args["dry_run"]:
        for t in todo:
            H.log("would render", t.get("name"), "->", os.path.join(out, f"{H.slugify(t.get('name'))}.{ext}"))
        return

    template = H.resolve(cfg, cfg.get("template"))
    if template:
        bpy.ops.wm.open_mainfile(filepath=template)
        scene = bpy.context.scene
        bind = cfg.get("bind", {})
    else:
        scene = H.empty_scene()
        build_default_card(bpy, scene)
        bind = cfg.get("bind", DEFAULT_BIND)
    if cfg.get("camera"):
        scene.camera = bpy.data.objects[cfg["camera"]]
    engine = H.set_engine(scene, cfg.get("engine") or ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"])
    device = H.use_gpu(scene, cfg.get("gpu"))
    if engine == "CYCLES":
        scene.cycles.samples = int(cfg.get("samples", 64))
    elif hasattr(scene, "eevee") and hasattr(scene.eevee, "taa_render_samples"):
        scene.eevee.taa_render_samples = int(cfg.get("samples", 64))
    w, h = cfg.get("resolution", [768, 1075])
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = int(w), int(h), 100
    scene.render.film_transparent = bool(cfg.get("transparent", False))
    scene.render.image_settings.file_format = fmt
    scene.render.image_settings.color_mode = "RGBA" if scene.render.film_transparent else "RGB"
    if fmt == "WEBP":
        scene.render.image_settings.quality = int(cfg.get("quality", 90))
    H.log(f"rendering {len(todo)} cards with {engine} ({device}) at {w}x{h}")

    renders = {}
    for t in todo:
        apply_bindings(bpy, bind, t, col)
        path = os.path.join(out, f"{H.slugify(t.get('name'))}.{ext}")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        renders[t.get("name")] = {"file": os.path.relpath(path, out).replace(os.sep, "/"), "sha256": H.sha256_file(path)}
        H.log("rendered", path)
    H.write_json(os.path.join(out, "renders.json"), renders)


if __name__ == "__main__":
    try:
        main()
    except H.ConfigError as e:
        H.fail(e)
