const test = require("node:test");
const assert = require("node:assert/strict");
const {
  estimateTokensFromChars,
  shouldAutoRoutePromptToCodeExecution,
  truncateOutput,
  validateUserCode,
} = require("../dist/utils.js");

test("estimateTokensFromChars uses simple 4-char heuristic", () => {
  assert.equal(estimateTokensFromChars(1), 1);
  assert.equal(estimateTokensFromChars(4), 1);
  assert.equal(estimateTokensFromChars(5), 2);
});

test("truncateOutput appends truncation notice", () => {
  const result = truncateOutput("abcdefghij", 5);
  assert.match(result, /^abcde/);
  assert.match(result, /Output truncated/);
});

test("validateUserCode rejects asyncio.run", () => {
  assert.throws(() => validateUserCode("import asyncio\nasyncio.run(main())"), /Top-level await is already available/);
});

test("validateUserCode rejects direct _rpc_call usage", () => {
  assert.throws(() => validateUserCode("result = await _rpc_call('read', {'path': 'x'})"), /Use the generated helper functions/);
});

test("shouldAutoRoutePromptToCodeExecution detects multi-file aggregation prompts", () => {
  assert.equal(
    shouldAutoRoutePromptToCodeExecution(
      "Analyze the first 8 test/**/*.test.ts files and return compact JSON only"
    ),
    true
  );
  assert.equal(
    shouldAutoRoutePromptToCodeExecution(
      "Count imports across src/**/*.ts and show the top 10 packages"
    ),
    true
  );
});

test("shouldAutoRoutePromptToCodeExecution ignores simple or mutating prompts", () => {
  assert.equal(shouldAutoRoutePromptToCodeExecution("Read src/index.ts"), false);
  assert.equal(shouldAutoRoutePromptToCodeExecution("Fix the failing tests in src/index.ts"), false);
});
