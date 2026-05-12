import { Injectable, Logger } from "@nestjs/common";
import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  FlexibleTimeWindowMode,
  ActionAfterCompletion,
} from "@aws-sdk/client-scheduler";

import { SchedulerConfigService } from "./scheduler-config.service";
import { DatabaseConfigService } from "./database-config.service";
import { SCHEDULER_SERVICE, ISchedulerService } from "../types/Scheduler";

export { SCHEDULER_SERVICE };
export type { ISchedulerService };

function buildScheduleName(sessionUlid: string): string {
  return `email-flush-${sessionUlid}`;
}

function toScheduleExpression(fireAtMs: number): string {
  const date = new Date(fireAtMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());

  return `at(${year}-${month}-${day}T${hours}:${minutes}:${seconds})`;
}

@Injectable()
export class SchedulerService implements ISchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly client: SchedulerClient;

  constructor(
    private readonly schedulerConfig: SchedulerConfigService,
    private readonly databaseConfig: DatabaseConfigService,
  ) {
    this.client = new SchedulerClient({ region: this.databaseConfig.region });
  }

  async createOrResetEmailFlush(sessionUlid: string, fireAtMs: number): Promise<void> {
    const name = buildScheduleName(sessionUlid);
    const scheduleExpression = toScheduleExpression(fireAtMs);

    await this.deleteScheduleIfExists(name, sessionUlid);

    try {
      await this.client.send(
        new CreateScheduleCommand({
          Name: name,
          ScheduleExpression: scheduleExpression,
          ScheduleExpressionTimezone: "UTC",
          FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
          Target: {
            Arn: this.schedulerConfig.apiDestinationArn,
            RoleArn: this.schedulerConfig.roleArn,
            Input: JSON.stringify({ sessionUlid }),
          },
          ActionAfterCompletion: ActionAfterCompletion.DELETE,
        }),
      );

      this.logger.log(
        `[event=schedule_created sessionUlid=${sessionUlid} fireAt=${new Date(fireAtMs).toISOString()}]`,
      );
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";

      if (errorName !== "ConflictException") {
        throw error;
      }

      this.logger.warn(`[event=schedule_create_conflict_retry sessionUlid=${sessionUlid}]`);

      await this.deleteScheduleIfExists(name, sessionUlid);

      await this.client.send(
        new CreateScheduleCommand({
          Name: name,
          ScheduleExpression: scheduleExpression,
          ScheduleExpressionTimezone: "UTC",
          FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
          Target: {
            Arn: this.schedulerConfig.apiDestinationArn,
            RoleArn: this.schedulerConfig.roleArn,
            Input: JSON.stringify({ sessionUlid }),
          },
          ActionAfterCompletion: ActionAfterCompletion.DELETE,
        }),
      );

      this.logger.log(
        `[event=schedule_created_after_retry sessionUlid=${sessionUlid} fireAt=${new Date(fireAtMs).toISOString()}]`,
      );
    }
  }

  async cancelEmailFlush(sessionUlid: string): Promise<void> {
    const name = buildScheduleName(sessionUlid);

    await this.deleteScheduleIfExists(name, sessionUlid);
  }

  async getEmailFlushFireTime(sessionUlid: string): Promise<number | null> {
    const name = buildScheduleName(sessionUlid);

    try {
      const result = await this.client.send(new GetScheduleCommand({ Name: name }));

      const expression = result.ScheduleExpression ?? "";
      const match = /at\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\)/.exec(expression);

      if (!match) {
        return null;
      }

      return new Date(`${match[1]}Z`).getTime();
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";

      if (errorName === "ResourceNotFoundException") {
        return null;
      }

      throw error;
    }
  }

  private async deleteScheduleIfExists(name: string, sessionUlid: string): Promise<void> {
    try {
      await this.client.send(new DeleteScheduleCommand({ Name: name }));

      this.logger.log(`[event=schedule_deleted sessionUlid=${sessionUlid}]`);
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : "UnknownError";

      if (errorName === "ResourceNotFoundException") {
        return;
      }

      throw error;
    }
  }
}
