import { Body, Controller, Delete, HttpCode, Post } from "@nestjs/common";

import { ZodValidationPipe } from "../pipes/knowledgeBaseValidation.pipe";
import { KnowledgeBaseIngestionService } from "../services/knowledge-base-ingestion.service";
import { KnowledgeBaseIngestDocumentResult } from "../types/KnowledgeBase";
import { ingestDocumentSchema, deleteDocumentSchema } from "../validation/knowledge-base.schema";
import type { IngestDocumentBody, DeleteDocumentBody } from "../validation/knowledge-base.schema";

@Controller("knowledge-base")
export class KnowledgeBaseController {
  constructor(private readonly ingestionService: KnowledgeBaseIngestionService) {}

  @Post("documents")
  @HttpCode(201)
  async ingestDocument(
    @Body(new ZodValidationPipe(ingestDocumentSchema)) body: IngestDocumentBody,
  ): Promise<KnowledgeBaseIngestDocumentResult> {
    // Schema validates the A#-prefixed form; strip the prefix so the service
    // and all downstream writes operate on the raw 26-character ULID only.
    const rawAccountId = body.account_id.slice(2);

    return this.ingestionService.ingestDocument({
      accountId: rawAccountId,
      externalId: body.external_id,
      title: body.title,
      text: body.text,
      sourceType: body.source_type,
      mimeType: body.mime_type,
    });
  }

  @Delete("documents")
  @HttpCode(204)
  async deleteDocument(
    @Body(new ZodValidationPipe(deleteDocumentSchema)) body: DeleteDocumentBody,
  ): Promise<void> {
    const rawAccountId = body.account_id.slice(2);
    return this.ingestionService.deleteDocument({ accountId: rawAccountId, externalId: body.external_id });
  }
}
