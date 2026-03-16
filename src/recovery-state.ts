import type { PtcSettings } from "./contracts/settings";

export type RecoveryFailureClass = "missing-await" | "async-wrapper-iterated";
export type RecoveryTerminalState = "success" | "failed_without_recovery" | "failed_after_recovery";

export interface PtcRecoveryState {
  routedToCodeExecution: boolean;
  codeExecutionAttempts: number;
  recoveryAttempted: boolean;
  failureClass: RecoveryFailureClass | null;
  terminalState: RecoveryTerminalState | null;
}

export function createPtcRecoveryState(): PtcRecoveryState {
  return {
    routedToCodeExecution: false,
    codeExecutionAttempts: 0,
    recoveryAttempted: false,
    failureClass: null,
    terminalState: null,
  };
}

export function noteCodeExecutionAttempt(state: PtcRecoveryState): void {
  state.routedToCodeExecution = true;
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
