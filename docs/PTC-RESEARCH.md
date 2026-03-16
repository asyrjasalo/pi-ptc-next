# PTC research, findings, and implementation notes

This document captures what was learned while aligning `pi-ptc-next` more closely with Anthropic's Programmatic Tool Calling (PTC) model behavior.

It is intentionally practical: how native PTC works, where `pi-ptc-next` differs, what was changed in this fork, and what still matters when authoring tools and prompts.

## TL;DR

`pi-ptc-next` already had the **runtime** half of PTC:

- a `code_execution` tool
- Python wrappers over local tools
- local RPC between Python and pi tools
- compact final outputs with intermediate results kept out of chat

What it lacked was enough of the **routing** half:

- clearer direct-vs-code tool boundaries
- stronger tool-selection guidance
- prompt-time steering toward `code_execution` for obvious PTC-shaped requests

That gap is what caused models to often ignore `code_execution` unless the user explicitly asked for it.

## Primary sources used

Vendored in this repo:

- `docs/advanced-tool-use.md`
- `docs/programmatic-tool-calling.md`

Additional external references used during research:

- Anthropic: Code execution with MCP
  - https://www.anthropic.com/engineering/code-execution-with-mcp
- Anthropic: Writing effective tools for agents
  - https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic Tool Choice cookbook
  - https://platform.claude.com/cookbook/tool-use-tool-choice
- Anthropic Implement Tool Use docs
  - https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use
- Anthropic Code Execution Tool docs
  - https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/code-execution-tool

## What native Anthropic PTC does

At a high level, Anthropic's native PTC flow is:

1. The API exposes a `code_execution_*` tool.
2. Other tools opt into programmatic calling with `allowed_callers: ["code_execution_..."]`.
3. Claude decides whether a task should be handled through direct tool use or through code execution.
4. If Claude chooses PTC, it writes Python that calls tools as async functions.
5. Tool results go back to the running code environment, not into the model's context window.
6. Claude receives only the final code output.

This is why PTC helps on:

- 3+ dependent tool calls
- loops and batching
- filtering, grouping, aggregation, ranking
- large intermediate results
- repeated lookups across many inputs

## Important Anthropic routing findings

### 1. PTC is not just a sandbox feature

The runtime matters, but tool selection matters just as much.

Anthropic's docs and articles consistently point to three levers that influence whether Claude picks the right execution path:

- detailed tool descriptions
- clear tool boundaries / namespacing
- examples and system-prompt guidance

### 2. `allowed_callers` is a major routing primitive

Anthropic explicitly recommends choosing either:

- `direct`
- `code_execution`

for a given tool rather than enabling both everywhere.

Why: if a tool is simultaneously available in both paths without clear guidance, the model has a less obvious routing decision. In practice that tends to bias models toward the simpler direct call path.

### 3. `tool_choice` does not solve this

Anthropic's PTC docs explicitly note that you **cannot force programmatic calling of a specific inner tool via `tool_choice`**.

So the answer is not "force tool choice harder".
The answer is better routing, clearer boundaries, and stronger guidance.

### 4. Tool descriptions matter more than most people think

Anthropic's implementation docs are blunt here: very detailed descriptions are the biggest factor in tool performance.

That includes:

- what a tool does
- when it should be used
- when it should not be used
- output format expectations
- important caveats

For PTC specifically, this means `code_execution` needs explicit examples of when it should be preferred over `read`/`grep`/`find`.

## How `pi-ptc-next` differs from native Anthropic PTC

`pi-ptc-next` is **not** Anthropic's wire protocol.

It is a provider-agnostic local implementation with similar behavior:

- the model sees a normal pi tool called `code_execution`
- the tool runs local Python
- Python calls pi tools over a local JSON-RPC bridge
- results are normalized into Python-friendly values
- only the final answer returns to the main model context

That means two things:

### What it already did well

- real local orchestration through Python
- provider-agnostic behavior across models
- token savings from hiding intermediate results
- reusable Python helpers and normalization

### What it could not inherit automatically

It did **not** get Anthropic's native routing semantics for free.

Before the routing work in this fork revision:

- direct tools were still active in the normal session
- the same capabilities were also available inside `code_execution`
- custom tools could opt into Python, but not cleanly be marked code-only vs direct-only
- there was no prompt-time steering layer

So the model often chose direct tools even when the task was an obvious PTC fit.

## What was implemented in this fork

### 1. Local `allowed_callers` equivalent

Added `ptc.callers` metadata for custom/extension tools:

```js
ptc: {
  enabled: true,
  readOnly: true,
  callers: ["code_execution"]
}
```

Supported values:

- `['direct']`
- `['code_execution']`
- `['direct', 'code_execution']`

Effect:

- code-only tools remain callable from Python
- code-only tools are no longer auto-activated as normal direct tools
- the extension now has a local routing vocabulary similar to Anthropic's `allowed_callers`

### 2. Prompt-time auto-routing

Added a conservative router in `before_agent_start`.

When a prompt strongly looks like a PTC task, the extension temporarily biases the active tool set toward `code_execution`.

Current positive signals include prompts about:

- repo-wide analysis
- multi-file scans
- repeated operations across many items
- counting / grouping / ranking / filtering / aggregation
- compact JSON / summary-only output
- keeping intermediate results out of chat

Current negative signals include prompts that look like mutations, e.g.:

- fix
- edit
- modify
- write
- implement
- patch

On `agent_end`, the previous active-tool state is restored.

### 3. Stronger `code_execution` guidance

The `code_execution` tool description now more explicitly says:

- prefer it first for repo-wide and many-step analysis
- use direct tools for tiny/simple lookups
- use it for grouped summaries / rankings / counts / compact JSON

### 4. Tests

Added regression coverage for:

- caller routing behavior in `ToolRegistry`
- code-only tools not being auto-activated directly
- prompt auto-routing behavior
- route detection heuristics

## Benchmark notes from this implementation pass

Prompt used:

> Analyze the first 8 `test/**/*.test.ts` files and return compact JSON only. For each file include path, line count, number of `test(` blocks, and whether it mentions `code_execution`. Do not include prose.

### `ccs-openai/gpt-5.4`

- with auto-routing **on**: correct result, `code_execution` used proactively
- with auto-routing **off**: the model still chose `code_execution`, but one run returned a wrong final result (`[]`)

Observed total tokens in this run pair:

- route on: `15751`
- route off: `14594`

Interpretation:

- routing improved reliability/correctness on this prompt
- token totals can still vary a lot by model behavior and retry shape
- correctness matters more than the raw token delta on a single run

### GLM turbo note

The user requested `glm-messages/glm-5-turbo`, but that exact provider/model name was not available in this pi installation.
The available equivalent was:

- `zai-messages/glm-5-turbo`

Observed total tokens in this run pair:

- route on: `15854`
- route off: `16785`

Interpretation:

- both runs were correct
- auto-routing reduced tool churn and token usage in this case

## Practical guidance for using `pi-ptc-next`

### For everyday usage

Use it normally.

The extension should now proactively lean toward `code_execution` when the request is a strong PTC fit, while still using direct tools for simple requests.

### For custom tools

Prefer explicit caller modes.

#### Direct-only tool

```js
ptc: {
  enabled: true,
  readOnly: true,
  callers: ["direct"]
}
```

#### Code-only helper

```js
ptc: {
  enabled: true,
  readOnly: true,
  callers: ["code_execution"]
}
```

#### Shared tool

```js
ptc: {
  enabled: true,
  readOnly: true,
  callers: ["direct", "code_execution"]
}
```

### For tool authors

Based on Anthropic guidance and the behavior seen here:

- write detailed descriptions
- say when the tool should and should not be used
- clearly document output shape
- keep tool boundaries sharp
- prefer code-only helper tools for heavy repeated lookups used mainly from Python
- avoid making everything available from both direct and code paths without reason

## Remaining limitations

This fork is much better aligned now, but some limits remain:

- tool selection is still model behavior, not a guaranteed deterministic planner
- built-in pi tools are still broadly available and may be chosen directly by some models
- the prompt router is heuristic, not semantic classification
- benchmark outcomes vary by provider/model and even by run

## Likely next improvements

If routing needs to become even more reliable, the best next steps are:

1. more evaluation prompts and benchmark fixtures
2. prompt-router heuristics informed by those evals
3. optional stricter routing modes for known analysis patterns
4. richer examples/few-shot guidance for `code_execution`
5. more explicit output-shape guidance for custom tools callable from Python

## Why this document exists

The key lesson from this work is simple:

**PTC is not only about being able to run Python. It is also about making the model want to choose that path at the right time.**

That is the core reason the routing and documentation changes in this fork matter.
