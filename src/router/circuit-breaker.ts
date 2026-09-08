import { CircuitState } from './types.js'
import { FAILOVER_TUNING_RANGES } from './types.js'

interface KeyCircuitState {
  state: CircuitState
  consecutiveErrors: number
  failureTimestamps: number[]
  lastErrorTime: number | null
  trippedAt: number | null
  recoveryOverrideMs: number | null
  selfCancelAt: number | null
  selfCancelTimer?: ReturnType<typeof setTimeout>
}

const MAX_WINDOW_SAMPLES = 32

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export class CircuitBreaker {
  private circuits: Map<string, KeyCircuitState> = new Map()
  private threshold: number
  private recoveryMs: number
  private selfCancelMs: number
  private windowFailures: number
  private windowMs: number
  private onSelfCancel: ((keyId: string) => void) | null = null

  constructor(threshold = 6, recoveryMs = 120_000, windowFailures = 12, windowSeconds = 300, selfCancelMs = 0) {
    this.threshold = clampInt(threshold, FAILOVER_TUNING_RANGES.circuitBreakerThreshold.min, FAILOVER_TUNING_RANGES.circuitBreakerThreshold.max, 6)
    this.recoveryMs = clampInt(recoveryMs, FAILOVER_TUNING_RANGES.circuitBreakerRecoveryMs.min, FAILOVER_TUNING_RANGES.circuitBreakerRecoveryMs.max, 120_000)
    this.selfCancelMs = selfCancelMs === 0 ? 0 : clampInt(selfCancelMs, 30_000, FAILOVER_TUNING_RANGES.breakerSelfCancelMs.max, 0)
    this.windowFailures = clampInt(windowFailures, FAILOVER_TUNING_RANGES.windowFailures.min, FAILOVER_TUNING_RANGES.windowFailures.max, 12)
    this.windowMs = clampInt(windowSeconds, FAILOVER_TUNING_RANGES.windowSeconds.min, FAILOVER_TUNING_RANGES.windowSeconds.max, 300) * 1000
  }

  setSelfCancelMs(value: number): void {
    this.selfCancelMs = value === 0 ? 0 : clampInt(value, 30_000, FAILOVER_TUNING_RANGES.breakerSelfCancelMs.max, this.selfCancelMs)
  }

  setOnSelfCancel(callback: ((keyId: string) => void) | null): void {
    this.onSelfCancel = callback
  }

  setThreshold(value: number): void {
    this.threshold = clampInt(value, FAILOVER_TUNING_RANGES.circuitBreakerThreshold.min, FAILOVER_TUNING_RANGES.circuitBreakerThreshold.max, this.threshold)
  }

  setRecoveryMs(value: number): void {
    this.recoveryMs = clampInt(value, FAILOVER_TUNING_RANGES.circuitBreakerRecoveryMs.min, FAILOVER_TUNING_RANGES.circuitBreakerRecoveryMs.max, this.recoveryMs)
  }

  setWindow(failures: number, seconds: number): void {
    this.windowFailures = clampInt(failures, FAILOVER_TUNING_RANGES.windowFailures.min, FAILOVER_TUNING_RANGES.windowFailures.max, this.windowFailures)
    this.windowMs = clampInt(seconds, FAILOVER_TUNING_RANGES.windowSeconds.min, FAILOVER_TUNING_RANGES.windowSeconds.max, this.windowMs / 1000) * 1000
  }

  reset(keyId: string): void {
    const circuit = this.circuits.get(keyId)
    if (!circuit) return
    this.clearSelfCancelTimer(circuit)
    circuit.state = CircuitState.CLOSED
    circuit.consecutiveErrors = 0
    circuit.failureTimestamps = []
    circuit.lastErrorTime = null
    circuit.trippedAt = null
    circuit.recoveryOverrideMs = null
    circuit.selfCancelAt = null
  }

  getTrippedAt(keyId: string): number | null {
    return this.circuits.get(keyId)?.trippedAt ?? null
  }

  getSelfCancelAt(keyId: string): number | null {
    return this.circuits.get(keyId)?.selfCancelAt ?? null
  }

  getState(keyId: string): CircuitState {
    return this.circuits.get(keyId)?.state ?? CircuitState.CLOSED
  }

  getConsecutiveErrors(keyId: string): number {
    return this.circuits.get(keyId)?.consecutiveErrors ?? 0
  }

  getWindowFailureCount(keyId: string): number {
    const circuit = this.circuits.get(keyId)
    if (!circuit) return 0
    return this.recentFailures(circuit, Date.now()).length
  }

  recordSuccess(keyId: string): boolean {
    const circuit = this.circuits.get(keyId)
    if (!circuit) return false

    if (circuit.state === CircuitState.HALF_OPEN) {
      circuit.state = CircuitState.CLOSED
      circuit.consecutiveErrors = 0
      circuit.trippedAt = null
      circuit.recoveryOverrideMs = null
      circuit.selfCancelAt = null
      this.clearSelfCancelTimer(circuit)
      return true
    }
    circuit.consecutiveErrors = 0
    return false
  }

  recordFailure(keyId: string, recoveryOverrideMs?: number | null): CircuitState {
    let circuit = this.circuits.get(keyId)
    if (!circuit) {
      circuit = {
        state: CircuitState.CLOSED,
        consecutiveErrors: 0,
        failureTimestamps: [],
        lastErrorTime: null,
        trippedAt: null,
        recoveryOverrideMs: null,
        selfCancelAt: null,
      }
      this.circuits.set(keyId, circuit)
    }

    const now = Date.now()
    circuit.consecutiveErrors++
    circuit.lastErrorTime = now
    circuit.failureTimestamps.push(now)
    if (circuit.failureTimestamps.length > MAX_WINDOW_SAMPLES) {
      circuit.failureTimestamps.splice(0, circuit.failureTimestamps.length - MAX_WINDOW_SAMPLES)
    }
    circuit.recoveryOverrideMs = typeof recoveryOverrideMs === 'number' && recoveryOverrideMs > 0
      ? Math.floor(recoveryOverrideMs)
      : null

    const recent = this.recentFailures(circuit, now).length
    if (circuit.consecutiveErrors >= this.threshold || recent >= this.windowFailures) {
      circuit.state = CircuitState.OPEN
      circuit.trippedAt = now
      this.armSelfCancel(keyId, circuit, now)
    }

    return circuit.state
  }

  tryRecovery(keyId: string): void {
    const circuit = this.circuits.get(keyId)
    if (!circuit || circuit.state !== CircuitState.OPEN) return
    if (circuit.selfCancelAt !== null) {
      if (Date.now() >= circuit.selfCancelAt) {
        this.selfCancelToHalfOpen(keyId, circuit)
      }
      return
    }
    if (!circuit.trippedAt) return

    const recoveryMs = circuit.recoveryOverrideMs ?? this.recoveryMs
    if (Date.now() - circuit.trippedAt >= recoveryMs) {
      circuit.state = CircuitState.HALF_OPEN
      circuit.recoveryOverrideMs = null
    }
  }

  private effectiveSelfCancelMs(circuit: KeyCircuitState): number {
    if (circuit.recoveryOverrideMs !== null) return circuit.recoveryOverrideMs
    if (this.selfCancelMs > 0) return this.selfCancelMs
    return this.recoveryMs
  }

  private armSelfCancel(keyId: string, circuit: KeyCircuitState, now: number): void {
    this.clearSelfCancelTimer(circuit)
    const waitMs = this.effectiveSelfCancelMs(circuit)
    circuit.selfCancelAt = now + waitMs
    circuit.selfCancelTimer = setTimeout(() => {
      const current = this.circuits.get(keyId)
      if (!current || current.state !== CircuitState.OPEN) return
      this.selfCancelToHalfOpen(keyId, current)
    }, waitMs)
    // Never hold the daemon process open for a recovery timer.
    if (typeof circuit.selfCancelTimer === 'object') {
      ;(circuit.selfCancelTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  private selfCancelToHalfOpen(keyId: string, circuit: KeyCircuitState): void {
    circuit.state = CircuitState.HALF_OPEN
    circuit.recoveryOverrideMs = null
    circuit.selfCancelAt = null
    this.clearSelfCancelTimer(circuit)
    this.onSelfCancel?.(keyId)
  }

  private clearSelfCancelTimer(circuit: KeyCircuitState): void {
    if (circuit.selfCancelTimer !== undefined) {
      clearTimeout(circuit.selfCancelTimer)
      circuit.selfCancelTimer = undefined
    }
  }

  isAvailable(keyId: string): boolean {
    this.tryRecovery(keyId)
    const state = this.getState(keyId)
    return state !== CircuitState.OPEN
  }

  private recentFailures(circuit: KeyCircuitState, now: number): number[] {
    const cutoff = now - this.windowMs
    while (circuit.failureTimestamps.length > 0 && circuit.failureTimestamps[0] < cutoff) {
      circuit.failureTimestamps.shift()
    }
    return circuit.failureTimestamps
  }
}
