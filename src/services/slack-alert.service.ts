import { Injectable, Logger } from "@nestjs/common";

import {
  SlackAlertBlock,
  SlackAlertCartCreatedInput,
  SlackAlertCheckoutLinkGeneratedInput,
  SlackAlertConversationStartedInput,
  SlackAlertPayload,
} from "../types/Slack";
import { SlackAlertConfigService } from "./slack-alert-config.service";
import { SentryService } from "./sentry.service";

const SLACK_REQUEST_TIMEOUT_MS = 5000;

const SLACK_ALERT_TYPE_CONVERSATION_STARTED = "conversation_started";
const SLACK_ALERT_TYPE_CART_CREATED = "cart_created";
const SLACK_ALERT_TYPE_CHECKOUT_LINK = "checkout_link";

const SLACK_HEADING_CONVERSATION_STARTED = "🟢 New conversation started";
const SLACK_HEADING_CART_CREATED = "🛒 Cart created by AI agent";
const SLACK_HEADING_CHECKOUT_LINK_GENERATED = "🔗 Checkout link generated";

@Injectable()
export class SlackAlertService {
  private readonly logger = new Logger(SlackAlertService.name);
  private readonly webhookUrl: string | undefined;

  constructor(
    private readonly slackAlertConfigService: SlackAlertConfigService,
    private readonly sentryService: SentryService,
  ) {
    this.webhookUrl = this.slackAlertConfigService.webhookUrl;

    if (!this.webhookUrl) {
      this.logger.log("Slack alerts disabled — SLACK_WEBHOOK_URL not configured");
    }
  }

  async notifyConversationStarted(input: SlackAlertConversationStartedInput): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const { accountId, sessionUlid } = input;

    try {
      await this.sendRequest(
        this.webhookUrl,
        {
          text: SLACK_HEADING_CONVERSATION_STARTED,
          blocks: this.buildConversationStartedBlocks(accountId, sessionUlid),
        },
        SLACK_ALERT_TYPE_CONVERSATION_STARTED,
      );
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";

      this.logger.error(
        `[errorType=${errorType} category=slack alertType=${SLACK_ALERT_TYPE_CONVERSATION_STARTED} action=notify_failed]`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "slack", alert_type: SLACK_ALERT_TYPE_CONVERSATION_STARTED },
      });
    }
  }

  async notifyCartCreated(input: SlackAlertCartCreatedInput): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const { accountId, sessionUlid, cartTotalCents, itemCount } = input;

    try {
      await this.sendRequest(
        this.webhookUrl,
        {
          text: SLACK_HEADING_CART_CREATED,
          blocks: this.buildCartCreatedBlocks(accountId, sessionUlid, cartTotalCents, itemCount),
        },
        SLACK_ALERT_TYPE_CART_CREATED,
      );
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";

      this.logger.error(
        `[errorType=${errorType} category=slack alertType=${SLACK_ALERT_TYPE_CART_CREATED} action=notify_failed]`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "slack", alert_type: SLACK_ALERT_TYPE_CART_CREATED },
      });
    }
  }

  async notifyCheckoutLinkGenerated(input: SlackAlertCheckoutLinkGeneratedInput): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const { accountId, sessionUlid, checkoutUrl } = input;

    try {
      await this.sendRequest(
        this.webhookUrl,
        {
          text: SLACK_HEADING_CHECKOUT_LINK_GENERATED,
          blocks: this.buildCheckoutLinkBlocks(accountId, sessionUlid, checkoutUrl),
        },
        SLACK_ALERT_TYPE_CHECKOUT_LINK,
      );
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";

      this.logger.error(
        `[errorType=${errorType} category=slack alertType=${SLACK_ALERT_TYPE_CHECKOUT_LINK} action=notify_failed]`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "slack", alert_type: SLACK_ALERT_TYPE_CHECKOUT_LINK },
      });
    }
  }

  private async sendRequest(webhookUrl: string, payload: SlackAlertPayload, alertType: string): Promise<void> {
    const signal = AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      await response.text().catch(() => undefined);
      throw new Error(`Slack POST failed [status=${response.status} alertType=${alertType}]`);
    }

    this.logger.debug(`[action=slack_alert_sent alertType=${alertType}]`);
  }

  private buildConversationStartedBlocks(accountId: string, sessionUlid: string): SlackAlertBlock[] {
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: SLACK_HEADING_CONVERSATION_STARTED,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: "*Account ID*" },
          { type: "mrkdwn", text: "*Session ID*" },
          { type: "plain_text", text: accountId },
          { type: "plain_text", text: sessionUlid },
        ],
      },
      {
        type: "divider",
      },
    ];
  }

  private buildCartCreatedBlocks(
    accountId: string,
    sessionUlid: string,
    cartTotalCents: number,
    itemCount: number,
  ): SlackAlertBlock[] {
    const formattedTotal = `$${(cartTotalCents / 100).toFixed(2)}`;

    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: SLACK_HEADING_CART_CREATED,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: "*Account ID*" },
          { type: "mrkdwn", text: "*Session ID*" },
          { type: "plain_text", text: accountId },
          { type: "plain_text", text: sessionUlid },
          { type: "mrkdwn", text: "*Items*" },
          { type: "mrkdwn", text: "*Cart Total*" },
          { type: "plain_text", text: String(itemCount) },
          { type: "plain_text", text: formattedTotal },
        ],
      },
      {
        type: "divider",
      },
    ];
  }

  private buildCheckoutLinkBlocks(accountId: string, sessionUlid: string, checkoutUrl: string): SlackAlertBlock[] {
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: SLACK_HEADING_CHECKOUT_LINK_GENERATED,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: "*Account ID*" },
          { type: "mrkdwn", text: "*Session ID*" },
          { type: "plain_text", text: accountId },
          { type: "plain_text", text: sessionUlid },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${checkoutUrl}|Open checkout>`,
        },
      },
      {
        type: "divider",
      },
    ];
  }
}
