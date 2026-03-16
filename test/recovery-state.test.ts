const test = require("node:test");
const assert = require("node:assert/strict");
const {
  armAutomaticRecovery,
  buildPtcExecutionTelemetry,
  buildPtcRecoveryDetails,
  canAttemptAutomaticRecovery,
  createPtcRecoveryState,
  noteAutomaticRouting,
  noteCodeExecutionAttempt,
  noteCodeExecutionFailure,
} = require("../dist/recovery-state.js");

test("PtcRecoveryState allows at most one automatic recovery attempt per request", () => {
  const settings = { autoRecover: true, autoRecoverMaxAttempts: 1 };
  const state = createPtcRecoveryState();

  noteCodeExecutionAttempt(state);
  assert.equal(canAttemptAutomaticRecovery(state, settings), true);
  assert.equal(armAutomaticRecovery(state, settings, "missing-await"), true);

  noteCodeExecutionAttempt(state);
  assert.equal(canAttemptAutomaticRecovery(state, settings), false);
  assert.equal(armAutomaticRecovery(state, settings, "async-wrapper-iterated"), false);

  noteCodeExecutionFailure(state);
  assert.deepEqual(state, {
    autoRouted: false,
    firstToolPath: "code_execution",
    routedToCodeExecution: true,
    codeExecutionAttempts: 2,
    recoveryAttempted: true,
    failureClass: "missing-await",
    terminalState: "failed_after_recovery",
  });
});

test("PtcRecoveryState builds ephemeral execution telemetry snapshots", () => {
  const state = createPtcRecoveryState();

  noteAutomaticRouting(state);
  noteCodeExecutionAttempt(state);
  const telemetry = buildPtcExecutionTelemetry(state);
  const recovery = buildPtcRecoveryDetails(state);

  assert.deepEqual(telemetry, {
    autoRouted: true,
    firstToolPath: "code_execution",
    codeExecutionAttempts: 1,
    recoveryAttemptCount: 0,
    terminalState: null,
  });
  assert.deepEqual(recovery, {
    eligible: false,
    attempted: false,
    failureClass: null,
  });
});
