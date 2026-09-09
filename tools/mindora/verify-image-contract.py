#!/usr/bin/env python3
"""Validate immutable image receipts against an explicit role manifest."""

import argparse
import json
import pathlib
import re
import sys
from typing import Any


SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
REQUIRED_RECEIPT_FIELDS = {
    "source_sha",
    "patch_sha",
    "role",
    "dockerfile",
    "target",
    "digest",
    "migration_command",
}


def _enabled_roles(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    components = manifest.get("components")
    if not isinstance(components, dict):
        return {}
    return {
        role: component
        for role, component in components.items()
        if isinstance(component, dict) and component.get("enabled") is True
    }


def validate(manifest: Any, receipts: Any, expected_patch_sha: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(expected_patch_sha, str) or not SHA_PATTERN.fullmatch(
        expected_patch_sha
    ):
        errors.append("expected patch SHA must be a lowercase 40-character Git SHA")
    if not isinstance(manifest, dict):
        return ["manifest must be a JSON object"]
    source_sha = manifest.get("dust_sha")
    if not isinstance(source_sha, str) or not SHA_PATTERN.fullmatch(source_sha):
        errors.append("manifest dust_sha must be a lowercase 40-character Git SHA")

    roles = _enabled_roles(manifest)
    if not roles:
        errors.append("manifest must explicitly enable at least one component")
    if not isinstance(receipts, list):
        return errors + ["receipts must be a JSON array"]

    receipts_by_role: dict[str, list[dict[str, Any]]] = {}
    for index, receipt in enumerate(receipts):
        if not isinstance(receipt, dict):
            errors.append(f"receipt {index} must be a JSON object")
            continue
        role = receipt.get("role")
        if not isinstance(role, str) or not role:
            errors.append(f"receipt {index} role must be a non-empty string")
            continue
        receipts_by_role.setdefault(role, []).append(receipt)

    for role, component in roles.items():
        matching = receipts_by_role.get(role, [])
        if len(matching) != 1:
            errors.append(f"enabled role {role} must have exactly one receipt; found {len(matching)}")
            continue
        receipt = matching[0]
        missing_fields = REQUIRED_RECEIPT_FIELDS - receipt.keys()
        if missing_fields:
            errors.append(f"role {role} is missing fields: {', '.join(sorted(missing_fields))}")
        if receipt.get("source_sha") != source_sha:
            errors.append(f"role {role} source_sha does not match manifest dust_sha")
        patch_sha = receipt.get("patch_sha")
        if not isinstance(patch_sha, str) or not SHA_PATTERN.fullmatch(patch_sha):
            errors.append(f"role {role} patch_sha must be a lowercase 40-character Git SHA")
        elif patch_sha != expected_patch_sha:
            errors.append(f"role {role} patch_sha does not match expected patch SHA")
        digest = receipt.get("digest")
        if not isinstance(digest, str) or not DIGEST_PATTERN.fullmatch(digest):
            errors.append(f"role {role} digest must be an immutable sha256 digest")
        for field in ("dockerfile", "target"):
            expected = component.get(field)
            actual = receipt.get(field)
            if not isinstance(expected, str) or not expected:
                errors.append(f"enabled role {role} manifest {field} must be recorded")
            elif actual != expected:
                errors.append(f"role {role} {field} does not match manifest")
        migration_command = receipt.get("migration_command")
        if migration_command is not None and not isinstance(migration_command, str):
            errors.append(f"role {role} migration_command must be a string or null")
        elif migration_command != component.get("migration_command"):
            errors.append(f"role {role} migration_command does not match manifest")

    for role, matching in receipts_by_role.items():
        if role not in roles:
            errors.append(f"receipt role {role} is not an enabled manifest role")
        if len(matching) > 1:
            errors.append(f"role {role} has duplicate receipts")

    return errors


def _read_json(path: pathlib.Path) -> Any:
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=pathlib.Path)
    parser.add_argument("receipts", type=pathlib.Path)
    parser.add_argument("expected_patch_sha")
    args = parser.parse_args()
    errors = validate(
        _read_json(args.manifest), _read_json(args.receipts), args.expected_patch_sha
    )
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("image contract verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
