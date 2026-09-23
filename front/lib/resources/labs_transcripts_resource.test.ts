import { LabsTranscriptsConfigurationResource } from "@app/lib/resources/labs_transcripts_resource";
import { LabsTranscriptsConfigurationModel } from "@app/lib/resources/storage/models/labs_transcripts";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { expect, it } from "vitest";

it("retains an ambiguous transcript for manual review without normal reprocessing", async () => {
  const { authenticator } = await createResourceTest({ role: "admin" });
  const workspace = authenticator.getNonNullableWorkspace();
  const user = authenticator.user();
  if (!user) {
    throw new Error("test user unavailable");
  }
  const model = await LabsTranscriptsConfigurationModel.create({
    workspaceId: workspace.id,
    userId: user.id,
    provider: "google_drive",
    connectionId: null,
    agentConfigurationId: null,
    status: "active",
    isDefaultWorkspaceConfiguration: false,
    dataSourceViewId: null,
    credentialId: null,
    useConnectorConnection: false,
  });
  const configuration = new LabsTranscriptsConfigurationResource(
    LabsTranscriptsConfigurationModel,
    model.get()
  );

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
