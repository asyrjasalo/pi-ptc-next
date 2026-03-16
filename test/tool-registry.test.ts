const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function createStubTool(name, description) {
  return {
    name,
    description,
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  };
}

function loadToolRegistryWithStubbedHost() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "@mariozechner/pi-coding-agent") {
      return {
        createReadTool: () => createStubTool("read", "read"),
        createBashTool: () => createStubTool("bash", "bash"),
        createEditTool: () => createStubTool("edit", "edit"),
        createWriteTool: () => createStubTool("write", "write"),
        createGrepTool: () => createStubTool("grep", "grep"),
        createFindTool: () => createStubTool("find", "find"),
        createLsTool: () => createStubTool("ls", "ls"),
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve("../dist/tool-registry.js")];
    return require("../dist/tool-registry.js").ToolRegistry;
  } finally {
    Module._load = originalLoad;
  }
}

function createRegistry() {
  const ToolRegistry = loadToolRegistryWithStubbedHost();
  const pi = {
    getAllTools() {
      return [];
    },
  };
  return new ToolRegistry(pi);
}

function baseSettings(overrides = {}) {
  return {
    executionTimeoutMs: 1000,
    maxOutputChars: 1000,
    allowMutations: false,
    allowBash: false,
    maxParallelToolCalls: 4,
    useDocker: false,
    allowUnsandboxedSubprocess: true,
    debugLogging: false,
    autoRoute: true,
    trustedReadOnlyTools: undefined,
    callableTools: undefined,
    blockedTools: undefined,
    ...overrides,
  };
}

function stringParamSchema() {
  return {
    type: "object",
    properties: {
      value: { type: "string" },
    },
    required: ["value"],
  };
}

test("ToolRegistry blocks untrusted custom read-only tools when mutations are disabled", () => {
  const registry = createRegistry();
  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    ptc: { enabled: true, readOnly: true },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const callable = registry.getCallableTools(process.cwd(), baseSettings());
  const names = callable.map((tool) => tool.name);

  assert.deepEqual(names.sort(), ["find", "glob", "grep", "ls", "read"]);
});

test("ToolRegistry allows trusted custom read-only tools when explicitly allowlisted", () => {
  const registry = createRegistry();
  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    ptc: { enabled: true, readOnly: true, pythonName: "query_db_readonly" },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const callable = registry.getCallableTools(
    process.cwd(),
    baseSettings({ trustedReadOnlyTools: ["query_db"] })
  );

  assert.ok(callable.some((tool) => tool.name === "query_db"));
});

test("ToolRegistry rejects duplicate python helper names", () => {
  const registry = createRegistry();
  const parameters = stringParamSchema();

  for (const name of ["tool_a", "tool_b"]) {
    registry.upsertTool({
      name,
      description: name,
      parameters,
      ptc: { enabled: true, readOnly: true, pythonName: "shared_name" },
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: undefined };
      },
    });
  }

  assert.throws(
    () => registry.getCallableTools(process.cwd(), baseSettings({ trustedReadOnlyTools: ["tool_a", "tool_b"] })),
    /Duplicate Python helper name/
  );
});

test("ToolRegistry respects code_execution-only callers for custom tools", () => {
  const registry = createRegistry();
  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    ptc: { enabled: true, readOnly: true, callers: ["code_execution"] },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const callable = registry.getCallableTools(
    process.cwd(),
    baseSettings({ trustedReadOnlyTools: ["query_db"] })
  );
  assert.ok(callable.some((tool) => tool.name === "query_db"));

  const routable = registry.getAutoRoutableToolNames(
    process.cwd(),
    baseSettings({ trustedReadOnlyTools: ["query_db"] })
  );
  assert.ok(!routable.includes("query_db"));
});

test("ToolRegistry auto-routing only hides tools callable both directly and from code_execution", () => {
  const registry = createRegistry();
  registry.upsertTool({
    name: "query_db",
    description: "Query DB",
    parameters: stringParamSchema(),
    ptc: { enabled: true, readOnly: true, callers: ["direct", "code_execution"] },
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });

  const routable = registry.getAutoRoutableToolNames(
    process.cwd(),
    baseSettings({ trustedReadOnlyTools: ["query_db"] })
  );
  assert.ok(routable.includes("read"));
  assert.ok(routable.includes("query_db"));
  assert.ok(!routable.includes("code_execution"));
});
