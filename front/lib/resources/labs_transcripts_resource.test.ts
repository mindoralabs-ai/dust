import { LabsTranscriptsConfigurationResource } from "@app/lib/resources/labs_transcripts_resource";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { expect, it } from "vitest";

it("retains an ambiguous transcript for manual review without normal reprocessing", async () => {
  const { authenticator } = await createResourceTest({ role: "admin" });
  const workspace = authenticator.getNonNullableWorkspace();
  const user = authenticator.user();
  if (!user) {
    throw new Error("test user unavailable");
  }
  const configuration = await LabsTranscriptsConfigurationResource.makeNew({
    workspaceId: workspace.id,
    userId: user.id,
    provider: "google_drive",
    connectionId: null,
    agentConfigurationId: null,
    isDefaultWorkspaceConfiguration: false,
    dataSourceViewId: null,
    credentialId: null,
    useConnectorConnection: false,
  });

  await configuration.recordHistory({
    workspace,
    fileId: "ambiguous-file",
    fileName: "Ambiguous transcript",
    manualReviewRequired: true,
  });
  const history = await configuration.fetchHistoryForFileId(
    authenticator,
    "ambiguous-file"
  );
  expect(history).toMatchObject({
    manualReviewRequired: true,
    stored: false,
    conversationId: null,
  });
});
