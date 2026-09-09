import fnmatch
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github/workflows/mindora-build.yml"
SPA_DOCKERFILE = ROOT / "dockerfiles/front-spa.Dockerfile"


def pull_request_paths(workflow: str) -> list[str]:
    match = re.search(
        r"(?ms)^  pull_request:\n    paths:\n(?P<paths>(?:      - .+\n)+)",
        workflow,
    )
    if match is None:
        raise AssertionError("pull_request paths block is missing")
    return re.findall(r'^      - "([^"]+)"$', match.group("paths"), re.MULTILINE)


class SourceBuildContractTest(unittest.TestCase):
    def test_representative_docker_inputs_trigger_the_workflow(self) -> None:
        paths = pull_request_paths(WORKFLOW.read_text(encoding="utf-8"))
        changed_inputs = (
            "package.json",
            "package-lock.json",
            "sdks/js/src/index.ts",
            "sparkle/src/index.ts",
            "scripts/db/migrate.ts",
            ".dockerignore",
            "LICENSE",
            "core/src/main.rs",
            "front-spa/src/app/main.tsx",
            "viz/src/index.ts",
            "egress-proxy/src/main.rs",
        )

        for changed_input in changed_inputs:
            with self.subTest(changed_input=changed_input):
                self.assertTrue(
                    any(fnmatch.fnmatch(changed_input, pattern) for pattern in paths),
                    f"{changed_input} does not trigger the source image workflow",
                )

        self.assertFalse(
            any(fnmatch.fnmatch("docs/architecture.md", pattern) for pattern in paths)
        )

    def test_spa_commit_hash_is_available_during_vite_build(self) -> None:
        dockerfile = SPA_DOCKERFILE.read_text(encoding="utf-8")
        build_stage, runtime_stage = dockerfile.split("\nFROM nginx:", maxsplit=1)

        self.assertIn("ARG COMMIT_HASH\n", build_stage)
        self.assertIn("ENV VITE_COMMIT_HASH=${COMMIT_HASH}\n", build_stage)
        self.assertLess(
            build_stage.index("ENV VITE_COMMIT_HASH=${COMMIT_HASH}"),
            build_stage.index("RUN npm -w front-spa run build:app"),
        )
        self.assertIn("ARG COMMIT_HASH\n", runtime_stage)
        self.assertIn("ARG COMMIT_HASH_LONG\n", runtime_stage)
        self.assertIn("ENV NEXT_PUBLIC_COMMIT_HASH=${COMMIT_HASH}\n", runtime_stage)
        self.assertIn("ENV DD_GIT_COMMIT_SHA=${DD_GIT_COMMIT_SHA}\n", runtime_stage)


if __name__ == "__main__":
    unittest.main()
