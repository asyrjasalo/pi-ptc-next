import type { PtcSettings } from "./contracts/settings";

export type RecoveryFailureClass = "missing-await" | "async-wrapper-iterated";
export type RecoveryTerminalState = "success" | "failed_without_recovery" | "failed_after_recovery";
export type PtcFirstToolPath = "code_execution" | "direct";

export interface PtcRecoveryState {
  autoRouted: boolean;
  firstToolPath: PtcFirstToolPath | null;
  routedToCodeExecution: boolean;
  codeExecutionAttempts: number;
  recoveryAttempted: boolean;
  failureClass: RecoveryFailureClass | null;
  terminalState: RecoveryTerminalState | null;
}

export interface PtcExecutionTelemetry {
  autoRouted: boolean;
  firstToolPath: PtcFirstToolPath | null;
  codeExecutionAttempts: number;
  recoveryAttemptCount: number;
  terminalState: RecoveryTerminalState | null;
}

export interface PtcRecoveryDetails {
  eligible: boolean;
  attempted: boolean;
  failureClass: RecoveryFailureClass | null;
}

export function createPtcRecoveryState(): PtcRecoveryState {
  return {
    autoRouted: false,
    firstToolPath: null,
    routedToCodeExecution: false,
    codeExecutionAttempts: 0,
    recoveryAttempted: false,
    failureClass: null,
    terminalState: null,
  };
}

export function noteAutomaticRouting(state: PtcRecoveryState): void {
  state.autoRouted = true;
}

export function noteCodeExecutionAttempt(state: PtcRecoveryState): void {
  state.routedToCodeExecution = true;
  if (!state.firstToolPath) {
    state.firstToolPath = "code_execution";
  }
  state.codeExecutionAttempts += 1;
}

export function canAttemptAutomaticRecovery(
  state: PtcRecoveryState,
  settings: Pick<PtcSettings, "autoRecover" | "autoRecoverMaxAttempts">
): boolean {
  return settings.autoRecover === true && (settings.autoRecoverMaxAttempts ?? 1) > 0 && state.codeExecutionAttempts > 0 && !state.recoveryAttempted;
}

export function armAutomaticRecovery(
  state: PtcRecoveryState,
  settings: Pick<PtcSettings, "autoRecover" | "autoRecoverMaxAttempts">,
  failureClass: RecoveryFailureClass
): boolean {
  if (!canAttemptAutomaticRecovery(state, settings)) {
    return false;
  }

  state.recoveryAttempted = true;
  state.failureClass = failureClass;
  return true;
}

export function noteCodeExecutionSuccess(state: PtcRecoveryState): void {
  state.terminalState = "success";
}

export function noteCodeExecutionFailure(state: PtcRecoveryState): void {
  state.terminalState = state.recoveryAttempted ? "failed_after_recovery" : "failed_without_recovery";
}

export function buildPtcExecutionTelemetry(state: PtcRecoveryState): PtcExecutionTelemetry {
  return {
    autoRouted: state.autoRouted,
    firstToolPath: state.firstToolPath,
    codeExecutionAttempts: state.codeExecutionAttempts,
    recoveryAttemptCount: state.recoveryAttempted ? 1 : 0,
    terminalState: state.terminalState,
  };
}

export function buildPtcRecoveryDetails(state: PtcRecoveryState): PtcRecoveryDetails {
  return {
    eligible: state.failureClass !== null,
    attempted: state.recoveryAttempted,
    failureClass: state.failureClass,
  };
}
