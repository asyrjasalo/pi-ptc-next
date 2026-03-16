const test = require("node:test");
const assert = require("node:assert/strict");

function setModuleExports(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const previous = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
  return () => {
    if (previous) {
      require.cache[resolved] = previous;
    } else {
      delete require.cache[resolved];
    }
  };
}

test("ptc extension bootstraps and cleans up runtime components", async () => {
  const sandbox = {
    cleanupCalls: 0,
    spawn() {
      throw new Error("sandbox spawn should not be used in bootstrap test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
    async cleanup() {
      this.cleanupCalls += 1;
    },
  };

  let managerInstance = null;
  let codeExecutorInstance = null;

  class FakeCustomToolManager {
    constructor(extensionRoot, pi, toolRegistry, onToolSetChanged) {
      this.extensionRoot = extensionRoot;
      this.pi = pi;
      this.toolRegistry = toolRegistry;
      this.onToolSetChanged = onToolSetChanged;
      this.started = 0;
      this.closed = 0;
      managerInstance = this;
    }

    async start() {
      this.started += 1;
      this.onToolSetChanged();
    }

    close() {
      this.closed += 1;
    }
  }

  class FakeToolRegistry {
    constructor(pi) {
      this.pi = pi;
    }

    getCallableTools() {
      return [];
    }

    getAutoRoutableToolNames() {
      return ["read", "grep"];
    }
  }

  class FakeCodeExecutor {
    constructor(sandboxManager, toolRegistry, settings, extensionRoot) {
      this.sandboxManager = sandboxManager;
      this.toolRegistry = toolRegistry;
      this.settings = settings;
      this.extensionRoot = extensionRoot;
      codeExecutorInstance = this;
    }

    async execute() {
      return {
        output: "ok",
        details: {
          nestedToolCalls: 0,
          nestedToolNames: [],
          nestedResultChars: 0,
          nestedResultCount: 0,
          nestedErrors: 0,
          durationMs: 1,
          estimatedAvoidedTokens: 0,
        },
      };
    }
  }

  const restoreSandbox = setModuleExports("../dist/sandbox-manager.js", {
    createSandbox: async () => sandbox,
  });
  const restoreManager = setModuleExports("../dist/custom-tool-manager.js", {
    CustomToolManager: FakeCustomToolManager,
  });
  const restoreRegistry = setModuleExports("../dist/tool-registry.js", {
    ToolRegistry: FakeToolRegistry,
  });
  const restoreExecutor = setModuleExports("../dist/code-executor.js", {
    CodeExecutor: FakeCodeExecutor,
  });

  try {
    delete require.cache[require.resolve("../dist/index.js")];
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const registered = [];
    const pi = {
      registerTool(tool) {
        registered.push(tool);
      },
      on(event, handler) {
        eventHandlers.set(event, handler);
      },
      getAllTools() {
        return [];
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    };

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const codeExecutionTools = registered.filter((tool) => tool.name === "code_execution");
    assert.ok(codeExecutionTools.length >= 1);
    assert.equal(managerInstance.started, 1);
    assert.equal(codeExecutorInstance.sandboxManager, sandbox);

    await eventHandlers.get("session_shutdown")();
    assert.equal(managerInstance.closed, 1);
    assert.equal(sandbox.cleanupCalls, 1);
  } finally {
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreExecutor();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension auto-routes repo-wide analysis prompts toward code_execution", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in bootstrap test");
    },
    getRuntimeWorkspaceRoot(cwd) {
      return cwd;
    },
  };

  class FakeCustomToolManager {
    async start() {}
    close() {}
  }

  class FakeToolRegistry {
    getCallableTools() {
      return [];
    }

    getAutoRoutableToolNames() {
      return ["read", "grep"];
    }
  }

  class FakeCodeExecutor {
    async execute() {
      return {
        output: "ok",
        details: {
          nestedToolCalls: 0,
          nestedToolNames: [],
          nestedResultChars: 0,
          nestedResultCount: 0,
          nestedErrors: 0,
          durationMs: 1,
          estimatedAvoidedTokens: 0,
        },
      };
    }
  }

  const restoreSandbox = setModuleExports("../dist/sandbox-manager.js", {
    createSandbox: async () => sandbox,
  });
  const restoreManager = setModuleExports("../dist/custom-tool-manager.js", {
    CustomToolManager: FakeCustomToolManager,
  });
  const restoreRegistry = setModuleExports("../dist/tool-registry.js", {
    ToolRegistry: FakeToolRegistry,
  });
  const restoreExecutor = setModuleExports("../dist/code-executor.js", {
    CodeExecutor: FakeCodeExecutor,
  });

  try {
    delete require.cache[require.resolve("../dist/index.js")];
    const extensionModule = require("../dist/index.js");
    const ptcExtension = extensionModule.default || extensionModule;

    const eventHandlers = new Map();
    const activeTools = ["read", "grep"];
    const pi = {
      registerTool() {},
      on(event, handler) {
        eventHandlers.set(event, handler);
      },
      getAllTools() {
        return [{ name: "code_execution" }];
      },
      getActiveTools() {
        return [...activeTools];
      },
      setActiveTools(next) {
        activeTools.splice(0, activeTools.length, ...next);
      },
    };

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const routeResult = eventHandlers.get("before_agent_start")({
      prompt: "Analyze the first 8 test/**/*.test.ts files and return compact JSON only",
      systemPrompt: "base prompt",
    });

    assert.deepEqual(activeTools, ["code_execution"]);
    assert.match(routeResult.systemPrompt, /Prefer calling code_execution first/);

    eventHandlers.get("agent_end")();
    assert.deepEqual(activeTools, ["read", "grep"]);
  } finally {
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreExecutor();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});
