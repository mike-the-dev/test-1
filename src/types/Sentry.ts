export interface SentryCaptureContext {
  tags?: Record<string, string>;
  extras?: Record<string, unknown>;
}
