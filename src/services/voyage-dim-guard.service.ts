import { Injectable, Logger } from "@nestjs/common";

import { VoyageService } from "./voyage.service";
import { SentryService } from "./sentry.service";
import { EXPECTED_VOYAGE_DIMENSION } from "./knowledge-base-ingestion.service";

const VOYAGE_DIM_PROBE_INPUT = "voyage-dimension-probe";
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class VoyageDimGuardService {
  private readonly logger = new Logger(VoyageDimGuardService.name);

  constructor(
    private readonly voyageService: VoyageService,
    private readonly sentryService: SentryService,
  ) {}

  async checkDimension(): Promise<void> {
    const startedAt = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1];
        await sleep(delayMs);
      }

      let vector: number[];

      try {
        vector = await this.voyageService.embedText(VOYAGE_DIM_PROBE_INPUT);
      } catch (error) {
        lastError = error;
        continue;
      }

      const actual = vector.length;

      if (actual !== EXPECTED_VOYAGE_DIMENSION) {
        const probeMs = Date.now() - startedAt;
        this.logger.error(
          `[event=boot_failed reason=voyage_dim_mismatch expected=${EXPECTED_VOYAGE_DIMENSION} actual=${actual} probeMs=${probeMs}]`,
        );
        this.sentryService.captureException(
          new Error(
            `Voyage dimension mismatch: expected ${EXPECTED_VOYAGE_DIMENSION}, got ${actual}`,
          ),
          { tags: { category: "voyage-dim-guard", severity: "fatal" } },
        );
        throw new Error(
          `[event=boot_failed reason=voyage_dim_mismatch expected=${EXPECTED_VOYAGE_DIMENSION} actual=${actual}]`,
        );
      }

      const probeMs = Date.now() - startedAt;
      this.logger.log(`[event=boot_ok dim=${actual} probeMs=${probeMs}]`);
      return;
    }

    // All attempts exhausted — Voyage is unreachable.
    const probeMs = Date.now() - startedAt;
    this.logger.error(
      `[event=boot_failed reason=voyage_unreachable probeMs=${probeMs}]`,
    );
    this.sentryService.captureException(lastError, {
      tags: { category: "voyage-dim-guard", severity: "fatal" },
    });
    throw new Error("[event=boot_failed reason=voyage_unreachable]");
  }
}
