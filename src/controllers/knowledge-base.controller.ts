import { Body, Controller, HttpCode, Post } from "@nestjs/common";

import { ZodValidationPipe } from "../pipes/knowledgeBaseValidation.pipe";
import { KnowledgeBaseIngestionService } from "../services/knowledge-base-ingestion.service";
import { KnowledgeBaseIngestDocumentResult } from "../types/KnowledgeBase";
import { ingestDocumentSchema } from "../validation/knowledge-base.schema";
import type { IngestDocumentBody } from "../validation/knowledge-base.schema";

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
    const rawAccountUlid = body.accountUlid.slice(2);

    return this.ingestionService.ingestDocument({
      accountUlid: rawAccountUlid,
      externalId: body.externalId,
      title: body.title,
      text: body.text,
      sourceType: body.sourceType,
      mimeType: body.mimeType,
    });
  }
}
