import copy
import importlib.util
import json
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "verify-image-contract.py"
FIXTURES = pathlib.Path(__file__).parent / "fixtures"
PATCH_SHA = "1111111111111111111111111111111111111111"


def load_verifier():
    spec = importlib.util.spec_from_file_location("verify_image_contract", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class VerifyImageContractTest(unittest.TestCase):
    def test_accepts_complete_immutable_receipts(self):
        verifier = load_verifier()
        manifest = json.loads((FIXTURES / "manifest.json").read_text())
        receipts = json.loads((FIXTURES / "valid-receipts.json").read_text())

        self.assertEqual(verifier.validate(manifest, receipts, PATCH_SHA), [])

    def test_rejects_missing_role_and_mutable_tag(self):
        verifier = load_verifier()
        manifest = json.loads((FIXTURES / "manifest.json").read_text())
        receipts = json.loads((FIXTURES / "invalid-receipts.json").read_text())

        errors = verifier.validate(manifest, receipts, PATCH_SHA)

        self.assertTrue(any("core_api" in error for error in errors))
        self.assertTrue(any("front_workers" in error and "digest" in error for error in errors))

    def test_rejects_consistently_wrong_patch_sha(self):
        verifier = load_verifier()
        manifest, receipts = self._valid_inputs()
        for receipt in receipts:
            receipt["patch_sha"] = "2" * 40

        errors = verifier.validate(manifest, receipts, PATCH_SHA)

        self.assertEqual(sum("does not match expected patch SHA" in error for error in errors), 3)

    def test_rejects_inconsistent_patch_sha(self):
        verifier = load_verifier()
        manifest, receipts = self._valid_inputs()
        receipts[1]["patch_sha"] = "3" * 40

        errors = verifier.validate(manifest, receipts, PATCH_SHA)

        self.assertEqual(sum("does not match expected patch SHA" in error for error in errors), 1)

    def test_rejects_duplicate_role(self):
        verifier = load_verifier()
        manifest, receipts = self._valid_inputs()
        receipts.append(copy.deepcopy(receipts[0]))

        errors = verifier.validate(manifest, receipts, PATCH_SHA)

        self.assertTrue(any("front_api has duplicate receipts" in error for error in errors))

    def test_rejects_unknown_role(self):
        verifier = load_verifier()
        manifest, receipts = self._valid_inputs()
        unknown = copy.deepcopy(receipts[0])
        unknown["role"] = "billing_worker"
        receipts.append(unknown)

        errors = verifier.validate(manifest, receipts, PATCH_SHA)

        self.assertTrue(any("billing_worker is not an enabled" in error for error in errors))

    def test_rejects_source_drift(self):
        verifier = load_verifier()
        manifest, receipts = self._valid_inputs()
        receipts[0]["source_sha"] = "4" * 40

        errors = verifier.validate(manifest, receipts, PATCH_SHA)

        self.assertTrue(any("source_sha does not match" in error for error in errors))

    def test_rejects_target_drift(self):
        verifier = load_verifier()
        manifest, receipts = self._valid_inputs()
        receipts[1]["target"] = "all-workers"

        errors = verifier.validate(manifest, receipts, PATCH_SHA)

        self.assertTrue(any("target does not match" in error for error in errors))

    def test_rejects_migration_drift(self):
        verifier = load_verifier()
        manifest, receipts = self._valid_inputs()
        receipts[2]["migration_command"] = "npm run migrate"

        errors = verifier.validate(manifest, receipts, PATCH_SHA)

        self.assertTrue(any("migration_command does not match" in error for error in errors))

    @staticmethod
    def _valid_inputs():
        manifest = json.loads((FIXTURES / "manifest.json").read_text())
        receipts = json.loads((FIXTURES / "valid-receipts.json").read_text())
        return manifest, receipts


if __name__ == "__main__":
    unittest.main()
