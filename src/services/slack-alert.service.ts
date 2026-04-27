import { Injectable, Logger } from "@nestjs/common";

import { SlackAlertConfigService } from "./slack-alert-config.service";
import { SentryService } from "./sentry.service";

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

interface SlackPayload {
  text: string;
  blocks: SlackBlock[];
}

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

  async notifyConversationStarted(input: {
    accountId: string;
    sessionUlid: string;
    startedAt: Date;
  }): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const { accountId, sessionUlid } = input;

    try {
      await this.sendRequest(
        {
          text: "🟢 New conversation started",
          blocks: this.buildConversationStartedBlocks(accountId, sessionUlid),
        },
        "conversation_started",
      );
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorType} category=slack alertType=conversation_started action=notify_failed]`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "slack", alert_type: "conversation_started" },
      });
    }
  }

  async notifyCartCreated(input: {
    accountId: string;
    sessionUlid: string;
    cartTotalCents: number;
    itemCount: number;
  }): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const { accountId, sessionUlid, cartTotalCents, itemCount } = input;

    try {
      await this.sendRequest(
        {
          text: "🛒 Cart created by AI agent",
          blocks: this.buildCartCreatedBlocks(accountId, sessionUlid, cartTotalCents, itemCount),
        },
        "cart_created",
      );
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorType} category=slack alertType=cart_created action=notify_failed]`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "slack", alert_type: "cart_created" },
      });
    }
  }

  async notifyCheckoutLinkGenerated(input: {
    accountId: string;
    sessionUlid: string;
    checkoutUrl: string;
  }): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const { accountId, sessionUlid, checkoutUrl } = input;

    try {
      await this.sendRequest(
        {
          text: "🔗 Checkout link generated",
          blocks: this.buildCheckoutLinkBlocks(accountId, sessionUlid, checkoutUrl),
        },
        "checkout_link",
      );
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      this.logger.error(
        `[errorType=${errorType} category=slack alertType=checkout_link action=notify_failed]`,
      );
      this.sentryService.captureException(error, {
        tags: { category: "slack", alert_type: "checkout_link" },
      });
    }
  }

  private async sendRequest(payload: SlackPayload, alertType: string): Promise<void> {
    const signal = AbortSignal.timeout(5000);

    const response = await fetch(this.webhookUrl!, {
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

  private buildConversationStartedBlocks(accountId: string, sessionUlid: string): SlackBlock[] {
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🟢 New conversation started",
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
  ): SlackBlock[] {
    const formattedTotal = `$${(cartTotalCents / 100).toFixed(2)}`;

    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🛒 Cart created by AI agent",
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

  private buildCheckoutLinkBlocks(accountId: string, sessionUlid: string, checkoutUrl: string): SlackBlock[] {
    return [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🔗 Checkout link generated",
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
