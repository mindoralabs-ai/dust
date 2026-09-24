import { VisualizationActionIframe } from "@app/components/assistant/conversation/actions/VisualizationActionIframe";
import { CenteredState } from "@app/components/assistant/conversation/interactive_content/CenteredState";
import { PublicInteractiveContentHeader } from "@app/components/assistant/conversation/interactive_content/PublicInteractiveContentHeader";
import { usePublicFrame } from "@app/lib/swr/frames";
import { useUser } from "@app/lib/swr/user";
import type {
  ScopedWorkspaceUserIdentity,
  WorkspaceUserIdentity,
} from "@app/types/assistant/visualization";
import { Spinner } from "@dust-tt/sparkle";
// biome-ignore lint/correctness/noUnusedImports: ignored using `--suppress`
import React from "react";

interface PublicFrameRendererProps {
  fileId: string;
  frameId?: string;
  title: string;
  hideHeader?: boolean;
  logoUrl?: string | null;
  showSignUpCta?: boolean;
  shareToken: string;
  workspaceId: string;
  vizUrl: string;
}

interface PublicFrameViewer extends WorkspaceUserIdentity {
  workspaces: { sId: string }[];
}

export function getPublicFrameUserIdentity(
  user: PublicFrameViewer | null,
  isAuthenticatedMember: boolean,
  workspaceId: string,
  // Standing of the viewer in the Pod hosting the Frame, resolved server-side by the public frame
  // endpoint. Display-only: invocations are re-authorized server-side.
  isPodMember = false,
  isPodEditor = false
): ScopedWorkspaceUserIdentity | undefined {
  if (
    !isAuthenticatedMember ||
    !user ||
    !user.workspaces.some((workspace) => workspace.sId === workspaceId)
  ) {
    return undefined;
  }

  return {
    workspaceId,
    isPodMember,
    isPodEditor,
    user: {
      sId: user.sId,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      image: user.image,
    },
  };
}

/**
 * @cc [owner:jchen0824,label:react;security] frame-member-api-authority
 * When the Frame API confirms workspace membership, load the viewer identity before enabling
 * function calls. An app-origin cookie must not suppress that lookup.
 */
export function PublicFrameRenderer({
  fileId,
  frameId,
  title,
  hideHeader = false,
  logoUrl,
  showSignUpCta = false,
  shareToken,
  workspaceId,
  vizUrl,
}: PublicFrameRendererProps) {
  const {
    conversationUrl,
    projectUrl,
    isFrameLoading,
    error,
    accessToken,
    isAuthenticatedMember,
    isPodMember,
    isPodEditor,
    framePath,
  } = usePublicFrame({
    shareToken,
  });

  const { user, isUserLoading } = useUser({
    revalidateOnFocus: false,
    revalidateIfStale: false,
    disabled: !isAuthenticatedMember,
    redirectOnUnauthenticated: false,
  });
  const publicUserIdentity = getPublicFrameUserIdentity(
    user,
    isAuthenticatedMember,
    workspaceId,
    isPodMember,
    isPodEditor
  );
  // The shared frame has no AuthProvider, so the viewer context the blocked-action cards need is
  // built from the workspace the viewer is a member of.
  const viewerWorkspace = user?.workspaces.find(
    (workspace) => workspace.sId === workspaceId
  );
  const viewer =
    publicUserIdentity && user && viewerWorkspace
      ? { owner: viewerWorkspace, user }
      : null;

  if (isFrameLoading || (isAuthenticatedMember && isUserLoading)) {
    return (
      <CenteredState>
        <Spinner size="sm" />
        <span>Loading the frame...</span>
      </CenteredState>
    );
  }

  if (error) {
    return (
      <CenteredState>
        <p className="text-warning-500">Error loading the frame: {error}</p>
      </CenteredState>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {!hideHeader && (
        <PublicInteractiveContentHeader
          title={title}
          user={user}
          conversationUrl={conversationUrl}
          projectUrl={projectUrl}
          logoUrl={logoUrl}
          showSignUpCta={showSignUpCta}
        />
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full">
          <VisualizationActionIframe
            agentConfigurationId={null}
            conversationId={null}
            workspaceId={workspaceId}
            vizUrl={vizUrl}
            visualization={{
              accessToken,
              complete: true,
              identifier: `viz-${fileId}`,
            }}
            key={`viz-${fileId}`}
            canInvokeFunctions={publicUserIdentity !== undefined}
            scopedUserIdentity={publicUserIdentity}
            viewer={viewer}
            framePath={framePath}
            frameId={frameId}
            isInDrawer
          />
        </div>
      </div>
    </div>
  );
}
