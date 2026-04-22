// Re-export the generic ZodValidationPipe under the knowledge-base domain file.
// The controller instantiates it with the KB-specific schema:
//   @Body(new ZodValidationPipe(ingestDocumentSchema)) body: IngestDocumentBody
// This matches the convention used by WebChatController / webChatValidation.pipe.ts.
export { ZodValidationPipe } from "./webChatValidation.pipe";
