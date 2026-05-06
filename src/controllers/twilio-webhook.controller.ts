import { Controller, Post, Body, Headers, HttpCode, Logger } from "@nestjs/common";
import twilio from "twilio";

import { SmsReplyService } from "../services/sms-reply.service";
import { TwilioConfigService } from "../services/twilio-config.service";
import type { SmsReplyTwilioInboundFormFields } from "../types/SmsReply";

@Controller("webhooks/twilio")
export class TwilioWebhookController {
  private readonly logger = new Logger(TwilioWebhookController.name);

  constructor(
    private readonly smsReplyService: SmsReplyService,
    private readonly twilioConfig: TwilioConfigService,
  ) {}

  /**
   * Receives inbound SMS webhooks from Twilio.
   *
   * Signature verification uses `twilio.validateRequest` with the URL built from
   * `TwilioConfigService.publicWebhookUrl` — NOT derived from request headers.
   * This prevents mismatch behind load balancers where `req.protocol` may be `http`
   * while the public-facing URL is `https`. Set `PUBLIC_WEBHOOK_URL` to the exact
   * URL Twilio uses to POST (including protocol, host, path prefix if any).
   *
   * Returns HTTP 200 with no body in all paths (Twilio convention — do not reveal
   * verification state to potential attackers).
   */
  @Post("inbound")
  @HttpCode(200)
  async handleInbound(
    @Body() body: SmsReplyTwilioInboundFormFields,
    @Headers("x-twilio-signature") signature: string | undefined,
  ): Promise<void> {
    const url = `${this.twilioConfig.publicWebhookUrl}/webhooks/twilio/inbound`;

    const isValid = this.verifySignature(signature, url, body);

    if (!isValid) {
      this.logger.warn("[event=twilio_signature_invalid outcome=rejected_signature_invalid]");
      // Respond 200 with no body — do not reveal verification state to potential attackers
      return;
    }

    const outcome = await this.smsReplyService.processInboundMessage(body);

    this.logger.log(`Twilio inbound webhook handled [outcome=${outcome}]`);
  }

  /**
   * Verifies the Twilio webhook signature using the SDK's `validateRequest`.
   *
   * The URL passed MUST exactly match the URL Twilio used to POST, including
   * protocol, host, path, and any trailing slash behavior. This is a common source
   * of "signature mismatch" failures — ensure `PUBLIC_WEBHOOK_URL` matches exactly.
   */
  private verifySignature(
    signature: string | undefined,
    url: string,
    params: SmsReplyTwilioInboundFormFields,
  ): boolean {
    if (!signature) {
      return false;
    }

    const authToken = this.twilioConfig.authToken;

    if (!authToken) {
      this.logger.error("TWILIO_AUTH_TOKEN not configured — cannot verify webhook signature");
      return false;
    }

    return twilio.validateRequest(authToken, signature, url, params);
  }
}
