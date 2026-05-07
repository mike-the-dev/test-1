import { Injectable, Logger } from "@nestjs/common";
import twilio from "twilio";

import { TwilioConfigService } from "./twilio-config.service";
import { SmsSendParams, SmsSendResult, SmsSdkErrorFields, SmsTwilioSdkError } from "../types/Sms";

function extractSdkErrorFields(error: SmsTwilioSdkError): SmsSdkErrorFields {
  return {
    code: String(error.code ?? "unknown"),
    moreInfo: String(error.moreInfo ?? "none"),
  };
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly client: ReturnType<typeof twilio>;

  constructor(private readonly twilioConfig: TwilioConfigService) {
    this.client = twilio(this.twilioConfig.accountSid, this.twilioConfig.authToken);
  }

  async send(params: SmsSendParams): Promise<SmsSendResult> {
    try {
      const message = await this.client.messages.create({
        from: params.from,
        to: params.to,
        body: params.body,
      });

      this.logger.log(
        `SMS sent successfully [messageSid=${message.sid} sessionUlid=${params.sessionUlid ?? "n/a"}]`,
      );

      return { messageSid: message.sid };
    } catch (error: unknown) {
      if (!(error instanceof Error)) {
        this.logger.error("SMS send failed [errorType=unknown]");
        throw error;
      }

      const { code: errorCode, moreInfo } = extractSdkErrorFields(error);

      this.logger.error(
        `SMS send failed [errorType=${error.name} code=${errorCode} moreInfo=${moreInfo}]`,
      );

      throw error;
    }
  }
}
