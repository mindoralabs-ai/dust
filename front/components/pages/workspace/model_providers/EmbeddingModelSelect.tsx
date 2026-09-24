import {
  DEFAULT_EMBEDDING_PROVIDER_ID,
  EMBEDDING_PROVIDER_IDS,
} from "@app/types/assistant/models/embedding";
import type { EmbeddingProviderIdType } from "@app/types/assistant/models/types";
import type { WorkspaceType } from "@app/types/user";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@dust-tt/sparkle";
import { useEffect, useState } from "react";

interface EmbeddingModelSelectProps {
  workspace?: WorkspaceType;
}

const EMBEDDING_PROVIDER_NAMES: Record<EmbeddingProviderIdType, string> = {
  vertex_ai: "Google Vertex AI",
  openai: "OpenAI",
  mistral: "Mistral AI",
};

export function EmbeddingModelSelect({ workspace }: EmbeddingModelSelectProps) {
  const [embeddingProvider, setEmbeddingProvider] =
    useState<EmbeddingProviderIdType>(DEFAULT_EMBEDDING_PROVIDER_ID);

  useEffect(() => {
    if (workspace?.defaultEmbeddingProvider) {
      setEmbeddingProvider(workspace.defaultEmbeddingProvider);
    }
  }, [workspace?.defaultEmbeddingProvider]);

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold">Embedding Provider:</div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled>
            <Button
              disabled
              tooltip="Please contact us if you want to change this setting."
              isSelect
              label={EMBEDDING_PROVIDER_NAMES[embeddingProvider]}
              variant="outline"
              size="sm"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {EMBEDDING_PROVIDER_IDS.map((provider) => (
              <DropdownMenuItem
                key={provider}
                label={EMBEDDING_PROVIDER_NAMES[provider]}
                onClick={() => {
                  setEmbeddingProvider(provider);
                }}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="text-sm text-muted-foreground">
        Embedding models are used to create numerical representations of your
        data powering the semantic search capabilities of your agents.
      </div>
    </div>
  );
}
