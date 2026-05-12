export const SCHEDULER_SERVICE = "SCHEDULER_SERVICE";

export interface SchedulerCreateOrResetResult {
  scheduleArn: string;
}

export interface SchedulerFireTimeResult {
  fireAtMs: number | null;
}

export interface ISchedulerService {
  createOrResetEmailFlush(sessionUlid: string, fireAtMs: number): Promise<void>;
  cancelEmailFlush(sessionUlid: string): Promise<void>;
  getEmailFlushFireTime(sessionUlid: string): Promise<number | null>;
}
