"""Shared helpers of the Rapture SDK Blender harness.

Every script runs the same way:

    blender --background --python blender/<script>.py -- --config <file.json>

The config is JSON; relative paths in it resolve against the config file's folder. The parts of this module that
need Blender import bpy inside the function, so the rest (argument parsing, config loading, slugs, export settings)
is plain Python and is unit-tested without Blender (blender/tests).
"""
import hashlib
import json
import os
import re
import sys


class ConfigError(Exception):
    pass


def script_args(argv=None):
    """The arguments after Blender's `--` separator (all of them when there is none)."""
    argv = sys.argv if argv is None else argv
    return argv[argv.index("--") + 1:] if "--" in argv else argv[1:]


def parse_args(argv=None):
    """`-- --config <file> [--only a,b] [--dry-run]` -> dict(config=..., only=[...], dry_run=bool)."""
    args = script_args(argv)
    out = {"config": None, "only": [], "dry_run": False}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--config" and i + 1 < len(args):
            out["config"] = args[i + 1]
            i += 2
        elif a == "--only" and i + 1 < len(args):
            out["only"] = [s for s in args[i + 1].split(",") if s]
            i += 2
        elif a == "--dry-run":
            out["dry_run"] = True
            i += 1
        else:
            raise ConfigError(f"unknown argument: {a}")
    if not out["config"]:
        raise ConfigError("usage: blender --background --python <script>.py -- --config <file.json> [--only a,b] [--dry-run]")
    return out


def load_config(path, required=()):
    """Read a JSON config; remember its folder so resolve() can find relative paths."""
    path = os.path.abspath(path)
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        raise ConfigError(f"{path}: {e}") from e
    if not isinstance(cfg, dict):
        raise ConfigError(f"{path}: expected a JSON object")
    missing = [k for k in required if k not in cfg]
    if missing:
        raise ConfigError(f"{path}: missing {', '.join(missing)}")
    cfg["_dir"] = os.path.dirname(path)
    return cfg


def resolve(cfg, value):
    """A path from the config: absolute as given, relative against the config's folder. None stays None."""
    if value is None:
        return None
    value = os.path.expanduser(str(value))
    return value if os.path.isabs(value) else os.path.normpath(os.path.join(cfg["_dir"], value))


def slugify(text):
    """'Ser Brightwall' -> 'ser-brightwall' (file names for renders and avatars)."""
    s = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return s or "untitled"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return "0x" + h.hexdigest()


def collection_tokens(cfg, key="collection"):
    """The token list of a Rapture SDK collection config named by cfg[key] (its "tokens" may be a file)."""
    path = resolve(cfg, cfg.get(key))
    if not path:
        raise ConfigError(f'"{key}": the collection.json whose tokens to use')
    col = load_config(path)
    tokens = col.get("tokens", [])
    if isinstance(tokens, str):
        tokens = _read_json(resolve(col, tokens))
    if not isinstance(tokens, list):
        raise ConfigError(f"{path}: tokens must be a list")
    return col, tokens


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise ConfigError(f"{path}: {e}") from e


def draco_settings(d):
    """glTF exporter keywords for Draco from a config value: false/None = off, true = defaults, or a dict."""
    if not d:
        return {}
    d = {} if d is True else dict(d)
    return {
        "export_draco_mesh_compression_enable": True,
        "export_draco_mesh_compression_level": int(d.get("level", 6)),
        "export_draco_position_quantization": int(d.get("position", 14)),
        "export_draco_normal_quantization": int(d.get("normal", 10)),
        "export_draco_texcoord_quantization": int(d.get("texcoord", 12)),
    }


def write_json(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def log(*parts):
    print("[rapture-sdk]", *parts, flush=True)


def fail(e):
    """Print a config or runtime error and exit non-zero (Blender keeps running otherwise)."""
    print(f"[rapture-sdk] ERROR: {e}", file=sys.stderr, flush=True)
    sys.exit(1)


# ---------------------------------------------------------------------------------------------------- Blender side

def export_glb(path, draco=None, **kw):
    """Export the selection (or scene) to GLB; Draco when asked, falling back to a plain GLB if the Draco library is
    missing from this Blender. Unknown exporter options for this Blender version are dropped, not fatal."""
    import bpy

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    base = {k: v for k, v in dict(filepath=path, export_format="GLB", **kw).items() if k in props}
    extra = {k: v for k, v in draco_settings(draco).items() if k in props}
    try:
        bpy.ops.export_scene.gltf(**base, **extra)
        return "draco" if extra else "plain"
    except Exception as e:  # noqa: BLE001 (the exporter raises RuntimeError with Blender's message)
        if not extra:
            raise
        log(f"Draco export failed ({e}); writing a plain GLB")
        bpy.ops.export_scene.gltf(**base)
        return "plain"


def set_engine(scene, preferred):
    """Assign the first render engine of `preferred` this Blender has (engine ids change between versions)."""
    import bpy

    engines = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    for e in preferred:
        if e in engines:
            scene.render.engine = e
            return e
    raise ConfigError(f"none of {preferred} is a render engine here (have {engines})")


def use_gpu(scene, backend=None):
    """Cycles on the GPU with the given backend (CUDA, OPTIX, HIP, METAL, ONEAPI), else the CPU."""
    import bpy

    if scene.render.engine != "CYCLES":
        return "n/a"
    if not backend:
        scene.cycles.device = "CPU"
        return "CPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        prefs.compute_device_type = backend
        prefs.refresh_devices()
    except TypeError as e:
        log(f"GPU backend {backend} unavailable ({e}); rendering on the CPU")
        scene.cycles.device = "CPU"
        return "CPU"
    used = 0
    for d in prefs.devices:
        d.use = d.type == backend
        used += d.use
    scene.cycles.device = "GPU" if used else "CPU"
    return scene.cycles.device


def empty_scene(keep_open_file=False):
    """A clean scene. keep_open_file: empty the current file instead of loading factory settings, which would unload
    add-ons (needed when a script runs inside a live Blender through MCP)."""
    import bpy

    if not keep_open_file:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        return bpy.context.scene
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights, bpy.data.curves, bpy.data.actions):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)
    return bpy.context.scene
