import { Injectable, Logger } from "@nestjs/common";

import {
  CartItemAlertEntry,
  SlackAlertBlock,
  SlackAlertCartCreatedInput,
  SlackAlertCheckoutLinkGeneratedInput,
  SlackAlertConversationStartedInput,
  SlackAlertPayload,
} from "../types/Slack";
import { SlackAlertConfigService } from "./slack-alert-config.service";
import { SentryService } from "./sentry.service";

// Escapes Slack mrkdwn control characters in user-supplied strings.
// Escapes &, <, > per Slack docs. * and _ are left unescaped (low risk in pet-services catalog data).
function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

    const { accountId, sessionUlid, guestCartId, cartTotalCents, items } = input;

    try {
      await this.sendRequest(
        this.webhookUrl,
        {
          text: SLACK_HEADING_CART_CREATED,
          blocks: this.buildCartCreatedBlocks(accountId, sessionUlid, guestCartId, cartTotalCents, items),
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

    const { accountId, sessionUlid, guestCartId, cartTotalCents, items, checkoutUrl } = input;

    try {
      await this.sendRequest(
        this.webhookUrl,
        {
          text: SLACK_HEADING_CHECKOUT_LINK_GENERATED,
          blocks: this.buildCheckoutLinkBlocks(accountId, sessionUlid, guestCartId, cartTotalCents, items, checkoutUrl),
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

  private formatCentsAsUsd(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  private buildItemsText(items: readonly CartItemAlertEntry[], cartTotalCents: number): string {
    // Max 20 items per cart; worst-case text is ~1520 chars, well under the 3000-char section limit.
    if (items.length === 0) {
      return `*Total: ${this.formatCentsAsUsd(cartTotalCents)}*`;
    }

    const bulletLines = items.map((item) => {
      return `• ${item.quantity}× ${escapeSlackMrkdwn(item.name)} — ${this.formatCentsAsUsd(item.subtotalCents)}`;
    });

    const lines = bulletLines.join("\n");

    return `${lines}\n*Total: ${this.formatCentsAsUsd(cartTotalCents)}*`;
  }

  private buildCartCreatedBlocks(
    accountId: string,
    sessionUlid: string,
    guestCartId: string,
    cartTotalCents: number,
    items: readonly CartItemAlertEntry[],
  ): SlackAlertBlock[] {
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
          { type: "mrkdwn", text: "*Cart ID*" },
          { type: "plain_text", text: guestCartId },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: this.buildItemsText(items, cartTotalCents),
        },
      },
      {
        type: "divider",
      },
    ];
  }

  private buildCheckoutLinkBlocks(
    accountId: string,
    sessionUlid: string,
    guestCartId: string,
    cartTotalCents: number,
    items: readonly CartItemAlertEntry[],
    checkoutUrl: string,
  ): SlackAlertBlock[] {
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
        text: {
          type: "mrkdwn",
          text: `*Account:* ${accountId}\n*Session:* ${sessionUlid}\n*Cart:* ${guestCartId}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: this.buildItemsText(items, cartTotalCents),
        },
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
