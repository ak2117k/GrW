/**
 * Public barrel for the TDA-010 signal fan-out engine.
 *
 * The stable surface TDA-011 consumes: the job shapes + idempotency key
 * (`ExecuteUserJob`, `PublicSignal`, `idempotencyKeyFor`), the producer service,
 * and the per-user rate limiter the execution pipeline runs behind. The
 * `AUTO_EXECUTION_PORT` DI token + `AutoExecutionPort` interface (which TDA-011
 * implements) are added with the execute-user worker.
 */
export type {
  PublicSignal,
  FanoutJob,
  ExecuteUserJob,
  Segment,
} from './dto/public-signal.dto';
export { toPublicSignal, idempotencyKeyFor } from './dto/public-signal.dto';
export { SignalFanoutService } from './services/signal-fanout.service';
export { PerUserRateLimiter, RateAcquireTimeoutError } from './services/per-user-rate-limiter';
export { FanoutEligibilityService } from './services/fanout-eligibility.service';
export type { EligibleUser } from './services/fanout-eligibility.service';
export { SignalFanoutModule } from './signal-fanout.module';
// The seam TDA-011 implements: bind a provider for AUTO_EXECUTION_PORT.
export { AUTO_EXECUTION_PORT } from './workers/execute-user.worker';
export type { AutoExecutionPort } from './workers/execute-user.worker';
