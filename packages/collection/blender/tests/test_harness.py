"""Unit tests of the harness's plain-Python parts and the Meshy request builders: no Blender, no network."""
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(PKG, "blender"))
sys.path.insert(0, os.path.join(PKG, "tools"))

import harness as H  # noqa: E402
import meshy_gen as M  # noqa: E402


class ArgsTest(unittest.TestCase):
    def test_reads_only_what_follows_blenders_separator(self):
        a = H.parse_args(["blender", "-b", "--python", "x.py", "--", "--config", "c.json", "--only", "a,b", "--dry-run"])
        self.assertEqual(a, {"config": "c.json", "only": ["a", "b"], "dry_run": True})

    def test_requires_a_config(self):
        with self.assertRaises(H.ConfigError):
            H.parse_args(["blender", "--"])
        with self.assertRaises(H.ConfigError):
            H.parse_args(["blender", "--", "--config", "c.json", "--bogus"])


class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def write(self, name, data):
        p = os.path.join(self.dir, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return p

    def test_resolves_paths_against_the_config_folder(self):
        cfg = H.load_config(self.write("c.json", {"out": "renders", "abs": os.path.abspath(os.sep)}), required=("out",))
        self.assertEqual(H.resolve(cfg, cfg["out"]), os.path.join(self.dir, "renders"))
        self.assertEqual(H.resolve(cfg, cfg["abs"]), os.path.abspath(os.sep))
        self.assertIsNone(H.resolve(cfg, None))

    def test_reports_missing_keys(self):
        with self.assertRaises(H.ConfigError):
            H.load_config(self.write("c.json", {}), required=("out",))

    def test_reads_a_collections_tokens_from_its_file(self):
        self.write("tokens.json", [{"name": "A"}])
        self.write("collection.json", {"name": "C", "tokens": "tokens.json"})
        cfg = H.load_config(self.write("cards.json", {"collection": "collection.json", "out": "o"}))
        col, tokens = H.collection_tokens(cfg)
        self.assertEqual(col["name"], "C")
        self.assertEqual(tokens, [{"name": "A"}])

    def test_the_example_configs_parse(self):
        for rel in ("examples/starter/blender/cards.json", "examples/rapture/blender/avatars.json",
                    "examples/rapture/blender/scene.json", "examples/rapture/blender/grade.json",
                    "examples/rapture/blender/key.json", "examples/rapture/blender/cards.json"):
            H.load_config(os.path.join(PKG, rel))


class HelpersTest(unittest.TestCase):
    def test_slugify(self):
        self.assertEqual(H.slugify("Ser Brightwall"), "ser-brightwall")
        self.assertEqual(H.slugify("  Halo: of the Throne! "), "halo-of-the-throne")
        self.assertEqual(H.slugify("***"), "untitled")

    def test_draco_settings(self):
        self.assertEqual(H.draco_settings(False), {})
        d = H.draco_settings({"level": 7, "position": 12})
        self.assertTrue(d["export_draco_mesh_compression_enable"])
        self.assertEqual(d["export_draco_mesh_compression_level"], 7)
        self.assertEqual(d["export_draco_position_quantization"], 12)
        self.assertEqual(H.draco_settings(True)["export_draco_normal_quantization"], 10)

    def test_sha256_file(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"abc")
        try:
            self.assertEqual(H.sha256_file(f.name), "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        finally:
            os.unlink(f.name)


class MeshyTest(unittest.TestCase):
    """Request building and config checks only: the API is never called."""

    def test_builds_preview_and_refine_requests(self):
        cfg = M.load_config(os.path.join(PKG, "examples", "rapture", "meshy.json"))
        a = cfg["assets"]["anvil"]
        pre = M.preview_request(cfg, a)
        self.assertEqual(pre["mode"], "preview")
        self.assertEqual(pre["target_polycount"], 3000)
        self.assertTrue(pre["prompt"].endswith("no background."))
        ref = M.refine_request(cfg, a, "task-1")
        self.assertEqual(ref["preview_task_id"], "task-1")
        self.assertEqual(ref["texture_prompt"], a["texture"])

    def test_needs_a_key_from_the_environment(self):
        if sys.platform == "win32":
            self.skipTest("on Windows the user's registry may hold a real key")
        with self.assertRaises(M.MeshyError):
            M.api_key({})
        self.assertEqual(M.api_key({"MESHY_API_KEY": "k"}), "k")


if __name__ == "__main__":
    unittest.main()
