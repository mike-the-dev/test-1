import { Module } from "@nestjs/common";

import { KnowledgeBaseConfigService } from "./knowledge-base-config.service";

@Module({
  providers: [KnowledgeBaseConfigService],
  exports: [KnowledgeBaseConfigService],
})
export class KnowledgeBaseConfigModule {}
