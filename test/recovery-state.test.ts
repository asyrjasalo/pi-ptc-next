const test = require("node:test");
const assert = require("node:assert/strict");
const {
  armAutomaticRecovery,
  canAttemptAutomaticRecovery,
  createPtcRecoveryState,
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
    routedToCodeExecution: true,
    codeExecutionAttempts: 2,
    recoveryAttempted: true,
    failureClass: "missing-await",
    terminalState: "failed_after_recovery",
  });
});
