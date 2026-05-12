import { WebChatToolOutput } from "./WebChat";

export type ReplyOrchestratorChannel = "web" | "sms" | "email";

export type ReplyOrchestratorOutcome =
  | { outcome: "replied"; reply: string; toolOutputs: WebChatToolOutput[] }
  | { outcome: "no_op_nothing_outstanding" };

export interface ReplyOrchestratorSmsSendContext {
  from: string;
  to: string;
}

export interface ReplyOrchestratorSendContext {
  sms?: ReplyOrchestratorSmsSendContext;
}
