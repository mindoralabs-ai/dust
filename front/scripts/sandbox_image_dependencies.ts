import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dependencyDockerfile } from "@app/lib/api/sandbox/image/preinstalled_dependencies";
import { getSandboxImageFromRegistry } from "@app/lib/api/sandbox/image/registry";
import logger from "@app/logger/logger";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// Generates a secret-free context. Build it in the trusted build environment,
// then pass the published digest to sandbox_image_build --preinstalled-image.
yargs(hideBin(process.argv))
  .option("image", { type: "string", default: "dust-base" })
  .option("base-image", {
    type: "string",
    demandOption: true,
    describe: "Selected Dust bedrock OCI image pinned by sha256 digest",
  })
  .option("output", { type: "string", demandOption: true })
  .parseAsync()
  .then((args) => {
    const result = getSandboxImageFromRegistry({ name: args.image });
    if (result.isErr()) {
      throw result.error;
    }
    const dockerfile = dependencyDockerfile(result.value, args.baseImage);
    mkdirSync(args.output, { recursive: true });
    const outputPath = path.join(args.output, "Dockerfile");
    writeFileSync(outputPath, dockerfile, { flag: "wx" });
    logger.info({ outputPath }, "Exported offline sandbox dependency context");
  });
