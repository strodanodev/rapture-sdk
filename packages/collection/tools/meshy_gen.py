"""Optional: generate low-poly 3D props or champions with Meshy text-to-3D (preview -> refine) and download the GLBs.

    python tools/meshy_gen.py --config meshy.json [--only anvil,barrel] [--dry-run]

Generalised from The Forge's scripts/meshy_gen.py. It spends Meshy credits: it needs YOUR key in the environment
variable MESHY_API_KEY (on Windows, a key set as a user variable after the shell started is read from the registry
too). The key is never written anywhere, and nothing in this package calls the API from its tests or `pnpm check`:
--dry-run prints the requests instead. Assets already downloaded are skipped, so a re-run only makes what is missing.
Import a result into Blender, clean it up, and export it with blender/export_avatars.py or export_scene.py.

Config (paths relative to this file):
  out                 download folder                                                      (required)
  style               text appended to every prompt
  assets              { "<name>": { "prompt": "...", "texture": "...", "polys": 3000 } }   (required)
  ai_model            default "latest"; topology "triangle" | "quad"; texture_resolution "2k"; pbr true
  parallel            assets generated at once (default 4)
"""
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://api.meshy.ai/openapi/v2/text-to-3d"
BALANCE = "https://api.meshy.ai/openapi/v1/balance"


class MeshyError(Exception):
    pass


def parse_args(argv):
    out = {"config": None, "only": [], "dry_run": False}
    i = 0
    while i < len(argv):
        if argv[i] == "--config" and i + 1 < len(argv):
            out["config"], i = argv[i + 1], i + 2
        elif argv[i] == "--only" and i + 1 < len(argv):
            out["only"], i = [s for s in argv[i + 1].split(",") if s], i + 2
        elif argv[i] == "--dry-run":
            out["dry_run"], i = True, i + 1
        else:
            raise MeshyError(f"unknown argument: {argv[i]}")
    if not out["config"]:
        raise MeshyError("usage: python tools/meshy_gen.py --config meshy.json [--only a,b] [--dry-run]")
    return out


def load_config(path):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    for k in ("out", "assets"):
        if k not in cfg:
            raise MeshyError(f"{path}: missing {k}")
    for name, a in cfg["assets"].items():
        if not isinstance(a, dict) or not a.get("prompt"):
            raise MeshyError(f'{path}: assets.{name} needs a "prompt"')
    cfg["out"] = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(path)), cfg["out"]))
    return cfg


def preview_request(cfg, asset):
    """The body of the preview (geometry) task."""
    style = cfg.get("style", "")
    return {
        "mode": "preview",
        "prompt": f"{asset['prompt']} {style}".strip(),
        "ai_model": cfg.get("ai_model", "latest"),
        "topology": cfg.get("topology", "triangle"),
        "should_remesh": True,
        "target_polycount": int(asset.get("polys", 3000)),
        "target_formats": ["glb"],
    }


def refine_request(cfg, asset, preview_id):
    """The body of the refine (texture) task."""
    body = {
        "mode": "refine",
        "preview_task_id": preview_id,
        "enable_pbr": bool(cfg.get("pbr", True)),
        "texture_resolution": cfg.get("texture_resolution", "2k"),
        "target_formats": ["glb"],
    }
    if asset.get("texture"):
        body["texture_prompt"] = asset["texture"]
    return body


def api_key(env=None):
    env = os.environ if env is None else env
    k = env.get("MESHY_API_KEY")
    if not k and sys.platform == "win32":
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as h:
                k = winreg.QueryValueEx(h, "MESHY_API_KEY")[0]
        except OSError:
            k = None
    if not k:
        raise MeshyError("set MESHY_API_KEY to your Meshy API key (it is never stored by this tool)")
    return k


def call(method, url, key, body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def wait(key, task_id, name, stage, poll=10):
    while True:
        t = call("GET", f"{API}/{task_id}", key)
        if t["status"] in ("SUCCEEDED", "FAILED", "CANCELED"):
            print(f"[{name}] {stage} {t['status']} credits={t.get('consumed_credits')}", flush=True)
            if t["status"] != "SUCCEEDED":
                raise MeshyError(f"{name} {stage}: {t.get('task_error')}")
            return t
        time.sleep(poll)


def make(cfg, key, name):
    dst = os.path.join(cfg["out"], f"{name}.glb")
    if os.path.exists(dst):
        return f"{name}: exists"
    asset = cfg["assets"][name]
    pre = call("POST", API, key, preview_request(cfg, asset))["result"]
    print(f"[{name}] preview task {pre}", flush=True)
    wait(key, pre, name, "preview")
    ref = call("POST", API, key, refine_request(cfg, asset, pre))["result"]
    print(f"[{name}] refine task {ref}", flush=True)
    t = wait(key, ref, name, "refine")
    urllib.request.urlretrieve(t["model_urls"]["glb"], dst)
    if t.get("thumbnail_url"):
        urllib.request.urlretrieve(t["thumbnail_url"], os.path.join(cfg["out"], f"{name}_thumb.png"))
    return f"{name}: {os.path.getsize(dst) / 1e6:.1f} MB"


def main(argv):
    args = parse_args(argv)
    cfg = load_config(args["config"])
    names = args["only"] or list(cfg["assets"])
    unknown = [n for n in names if n not in cfg["assets"]]
    if unknown:
        raise MeshyError(f"not in assets: {', '.join(unknown)}")
    if args["dry_run"]:
        for n in names:
            print(json.dumps({"asset": n, "preview": preview_request(cfg, cfg["assets"][n])}, indent=2))
        return
    key = api_key()
    os.makedirs(cfg["out"], exist_ok=True)
    with ThreadPoolExecutor(max(1, min(len(names), int(cfg.get("parallel", 4))))) as ex:
        for fut in [ex.submit(make, cfg, key, n) for n in names]:
            try:
                print(fut.result(), flush=True)
            except Exception as e:  # noqa: BLE001 (report each asset, keep going)
                print("ERROR", e, flush=True)
    print("balance:", call("GET", BALANCE, key).get("balance"))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except MeshyError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
