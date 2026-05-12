import { Injectable, Logger } from "@nestjs/common";

import { ISchedulerService } from "../types/Scheduler";

@Injectable()
export class SchedulerFakeService implements ISchedulerService {
  private readonly logger = new Logger(SchedulerFakeService.name);
  private readonly schedules = new Map<string, number>();

  async createOrResetEmailFlush(sessionUlid: string, fireAtMs: number): Promise<void> {
    this.schedules.set(sessionUlid, fireAtMs);

    this.logger.log(
      `[event=fake_schedule_created sessionUlid=${sessionUlid} fireAt=${new Date(fireAtMs).toISOString()}]`,
    );
  }

  async cancelEmailFlush(sessionUlid: string): Promise<void> {
    this.schedules.delete(sessionUlid);

    this.logger.log(`[event=fake_schedule_deleted sessionUlid=${sessionUlid}]`);
  }

  async getEmailFlushFireTime(sessionUlid: string): Promise<number | null> {
    return this.schedules.get(sessionUlid) ?? null;
  }
}
