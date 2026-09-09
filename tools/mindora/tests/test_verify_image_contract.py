import importlib.util
import json
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "verify-image-contract.py"
FIXTURES = pathlib.Path(__file__).parent / "fixtures"


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

        self.assertEqual(verifier.validate(manifest, receipts), [])

    def test_rejects_missing_role_and_mutable_tag(self):
        verifier = load_verifier()
        manifest = json.loads((FIXTURES / "manifest.json").read_text())
        receipts = json.loads((FIXTURES / "invalid-receipts.json").read_text())

        errors = verifier.validate(manifest, receipts)

        self.assertTrue(any("core_api" in error for error in errors))
        self.assertTrue(any("front_workers" in error and "digest" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
