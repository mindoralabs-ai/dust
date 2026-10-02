import fnmatch
import json
import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github/workflows/mindora-build.yml"
SPA_DOCKERFILE = ROOT / "dockerfiles/front-spa.Dockerfile"
CORE_DOCKERFILE = ROOT / "dockerfiles/core.Dockerfile"
VIZ_DOCKERFILE = ROOT / "dockerfiles/viz.Dockerfile"
CONNECTORS_DOCKERFILE = ROOT / "dockerfiles/connectors.Dockerfile"
IMAGE_CONTRACT = ROOT / "docs/mindora/image-contract.json"


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
            "connectors/src/start_worker.ts",
            "dockerfiles/connectors.Dockerfile",
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

    def test_spa_static_website_url_is_available_during_vite_build(self) -> None:
        # config.getStaticWebsiteUrl() throws in the browser when this is not inlined.
        dockerfile = SPA_DOCKERFILE.read_text(encoding="utf-8")
        build_stage = dockerfile.split("\nFROM nginx:", maxsplit=1)[0]
        env = "ENV NEXT_PUBLIC_DUST_STATIC_WEBSITE_URL=${NEXT_PUBLIC_DUST_STATIC_WEBSITE_URL}"

        self.assertIn("ARG NEXT_PUBLIC_DUST_STATIC_WEBSITE_URL\n", build_stage)
        self.assertIn(env + "\n", build_stage)
        self.assertLess(
            build_stage.index(env),
            build_stage.index("RUN npm -w front-spa run build:app"),
        )
        self.assertRegex(
            WORKFLOW.read_text(encoding="utf-8"),
            r"--build-arg NEXT_PUBLIC_DUST_STATIC_WEBSITE_URL=\S+ \\\n",
        )

    def test_core_image_builds_and_packages_database_initializer(self) -> None:
        dockerfile = CORE_DOCKERFILE.read_text(encoding="utf-8")
        build_stage, runtime_stage = dockerfile.split(
            "\nFROM debian:bookworm-slim", maxsplit=1
        )

        self.assertRegex(
            build_stage,
            r"(?s)cargo build .*--release .*--bin init_db",
        )
        self.assertIn(
            "COPY --from=builder /app/target/release/init_db /usr/local/bin/init_db",
            runtime_stage,
        )
        self.assertIn('CMD ["core-api"]', runtime_stage)

    def test_viz_origin_is_available_during_next_build(self) -> None:
        dockerfile = VIZ_DOCKERFILE.read_text(encoding="utf-8")

        self.assertIn("ARG ALLOWED_VISUALIZATION_ORIGIN\n", dockerfile)
        self.assertIn(
            "ENV ALLOWED_VISUALIZATION_ORIGIN=${ALLOWED_VISUALIZATION_ORIGIN}\n",
            dockerfile,
        )
        self.assertLess(
            dockerfile.index(
                "ENV ALLOWED_VISUALIZATION_ORIGIN=${ALLOWED_VISUALIZATION_ORIGIN}"
            ),
            dockerfile.index("RUN npm run build"),
        )

    def test_enabled_roles_name_a_stage_of_their_dockerfile(self) -> None:
        manifest = json.loads(IMAGE_CONTRACT.read_text(encoding="utf-8"))

        for role, component in manifest["components"].items():
            if component.get("enabled") is not True:
                continue
            with self.subTest(role=role):
                dockerfile_path = ROOT / component["dockerfile"]
                dockerfile = dockerfile_path.read_text(encoding="utf-8")
                self.assertRegex(
                    dockerfile,
                    rf"(?m)^FROM \S+ AS {re.escape(component['target'])}$",
                )

    def test_connectors_image_packages_migration_and_worker_runtime(self) -> None:
        dockerfile = CONNECTORS_DOCKERFILE.read_text(encoding="utf-8")

        self.assertRegex(
            dockerfile,
            r"(?m)^FROM node:[0-9.]+@sha256:[0-9a-f]{64} AS connectors$",
        )
        self.assertRegex(dockerfile, r"(?m)^\s*apt-get install .*\bpostgresql-client\b")
        # The migration command runs ../scripts/db/run-migrate.cjs from /app/connectors.
        self.assertIn("COPY /scripts/db /app/scripts/db\n", dockerfile)
        connectors_build = dockerfile.split(
            "\nWORKDIR /app/connectors\n", maxsplit=1
        )[1]
        self.assertLess(
            connectors_build.index("npm run build:temporal-bundles\n"),
            connectors_build.index("RUN npm run build\n"),
        )
        self.assertEqual(
            re.findall(r"(?m)^WORKDIR (\S+)$", dockerfile)[-1], "/app/connectors"
        )
        self.assertRegex(dockerfile, r"(?m)^ARG DATADOG_API_KEY$")


if __name__ == "__main__":
    unittest.main()
