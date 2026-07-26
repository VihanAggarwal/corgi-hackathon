/**
 * Resilience layer public surface. Track C.
 *
 * Everything that leaves this process (Anthropic, Places, Merge, Photon,
 * Supabase) goes through withFallback. Everything the duel feed needs comes
 * from getOfflineCorpusSnapshot, which never touches the network at all.
 * app/api/health imports checkHealth from here and nowhere deeper.
 *
 * Deep imports into ./call, ./degradation, ./corpus-cache, or ./health from
 * outside this directory are how the seam stops being a seam: this file is
 * where a caller finds out what the resilience layer promises, not what it
 * happens to implement today.
 */

export {
  withTimeout,
  withFallback,
  notConfiguredNotice,
  TimeoutError,
  OperationAbortedError,
  FallbackFailedError,
  type ResilienceEvent,
  type ResilienceEventType,
  type ResilientOptions,
  type ResilientResult,
} from './call';

export {
  redact,
  describeError,
  recordDegradation,
  recentDegradations,
  clearDegradations,
  DEGRADATION_LOG_CAPACITY,
  type DegradeReason,
  type DegradedNotice,
} from './degradation';

export {
  getOfflineCorpusSnapshot,
  resetOfflineCorpusCache,
  sampleDuelPairs,
  type CorpusSnapshot,
  type CorpusCacheOptions,
  type OfflineDuelPair,
  type OfflineDishView,
} from './corpus-cache';

export {
  checkHealth,
  type DependencyName,
  type DependencyStatus,
  type DependencyHealth,
  type HealthReport,
  type HealthOptions,
} from './health';
