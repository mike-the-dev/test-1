export interface EmailFlushRequestBody {
  sessionUlid: string;
}

export type EmailFlushProcessOutcome = "dispatched" | "no_op";
