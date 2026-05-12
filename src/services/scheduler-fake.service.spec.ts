import { SchedulerFakeService } from "./scheduler-fake.service";

const SESSION_A = "01SESSNA0000000000000000000";
const SESSION_B = "01SESSNB0000000000000000000";

describe("SchedulerFakeService", () => {
  let fake: SchedulerFakeService;

  beforeEach(() => {
    fake = new SchedulerFakeService();
  });

  // ---------------------------------------------------------------------------
  // createOrResetEmailFlush
  // ---------------------------------------------------------------------------

  describe("createOrResetEmailFlush", () => {
    it("stores the sessionUlid → fireAtMs mapping", async () => {
      const fireAtMs = Date.now() + 90_000;

      await fake.createOrResetEmailFlush(SESSION_A, fireAtMs);

      const stored = await fake.getEmailFlushFireTime(SESSION_A);
      expect(stored).toBe(fireAtMs);
    });

    it("overwrites existing entry when called again for the same session", async () => {
      const firstFireAt = Date.now() + 90_000;
      const secondFireAt = Date.now() + 180_000;

      await fake.createOrResetEmailFlush(SESSION_A, firstFireAt);
      await fake.createOrResetEmailFlush(SESSION_A, secondFireAt);

      const stored = await fake.getEmailFlushFireTime(SESSION_A);
      expect(stored).toBe(secondFireAt);
    });

    it("stores separate entries for different sessions", async () => {
      const fireA = Date.now() + 90_000;
      const fireB = Date.now() + 60_000;

      await fake.createOrResetEmailFlush(SESSION_A, fireA);
      await fake.createOrResetEmailFlush(SESSION_B, fireB);

      expect(await fake.getEmailFlushFireTime(SESSION_A)).toBe(fireA);
      expect(await fake.getEmailFlushFireTime(SESSION_B)).toBe(fireB);
    });
  });

  // ---------------------------------------------------------------------------
  // cancelEmailFlush
  // ---------------------------------------------------------------------------

  describe("cancelEmailFlush", () => {
    it("removes the entry so getEmailFlushFireTime returns null afterwards", async () => {
      await fake.createOrResetEmailFlush(SESSION_A, Date.now() + 90_000);
      await fake.cancelEmailFlush(SESSION_A);

      const stored = await fake.getEmailFlushFireTime(SESSION_A);
      expect(stored).toBeNull();
    });

    it("is idempotent — does not throw when called on a session with no entry", async () => {
      await expect(fake.cancelEmailFlush(SESSION_A)).resolves.toBeUndefined();
    });

    it("does not remove entries for other sessions", async () => {
      const fireB = Date.now() + 90_000;

      await fake.createOrResetEmailFlush(SESSION_A, Date.now() + 60_000);
      await fake.createOrResetEmailFlush(SESSION_B, fireB);
      await fake.cancelEmailFlush(SESSION_A);

      expect(await fake.getEmailFlushFireTime(SESSION_B)).toBe(fireB);
    });
  });

  // ---------------------------------------------------------------------------
  // getEmailFlushFireTime
  // ---------------------------------------------------------------------------

  describe("getEmailFlushFireTime", () => {
    it("returns the stored fireAtMs when an entry exists", async () => {
      const fireAtMs = 1_750_000_000_000;

      await fake.createOrResetEmailFlush(SESSION_A, fireAtMs);

      const result = await fake.getEmailFlushFireTime(SESSION_A);
      expect(result).toBe(fireAtMs);
    });

    it("returns null when no entry exists for the session", async () => {
      const result = await fake.getEmailFlushFireTime(SESSION_A);
      expect(result).toBeNull();
    });

    it("returns null after the entry has been cancelled", async () => {
      await fake.createOrResetEmailFlush(SESSION_A, Date.now() + 90_000);
      await fake.cancelEmailFlush(SESSION_A);

      const result = await fake.getEmailFlushFireTime(SESSION_A);
      expect(result).toBeNull();
    });
  });
});
