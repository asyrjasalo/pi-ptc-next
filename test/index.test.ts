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

test("ptc extension resets recovery state for each user request", async () => {
  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery state test");
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
      return [];
    }
  }

  const seenStates = [];
  class FakeCodeExecutor {
    async execute(_code, options) {
      seenStates.push(options.recoveryState);
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
        return [{ name: "code_execution" }];
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    };

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const codeExecutionTool = registered.find((tool) => tool.name === "code_execution");
    assert.ok(codeExecutionTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await codeExecutionTool.execute("call-1", { code: "return 1" }, undefined, undefined, { cwd: process.cwd() });
    await codeExecutionTool.execute("call-2", { code: "return 2" }, undefined, undefined, { cwd: process.cwd() });

    const firstRequestState = seenStates[0];
    assert.equal(seenStates[1], firstRequestState);
    assert.deepEqual(firstRequestState, {
      routedToCodeExecution: true,
      codeExecutionAttempts: 2,
      recoveryAttempted: false,
      failureClass: null,
      terminalState: "success",
    });

    eventHandlers.get("agent_end")();
    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await codeExecutionTool.execute("call-3", { code: "return 3" }, undefined, undefined, { cwd: process.cwd() });

    const secondRequestState = seenStates[2];
    assert.notEqual(secondRequestState, firstRequestState);
    assert.deepEqual(secondRequestState, {
      routedToCodeExecution: true,
      codeExecutionAttempts: 1,
      recoveryAttempted: false,
      failureClass: null,
      terminalState: "success",
    });
  } finally {
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreExecutor();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension appends one targeted recovery message on the next turn after a qualifying async failure", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");
  const recoveryPrompt =
    "PTC recovery: You called an async helper without await. Helpers like read, glob, find, grep, and ls are async wrappers. Await each helper call before using its result.";

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery lifecycle test");
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
      return [];
    }
  }

  class FakeCodeExecutor {
    async execute() {
      throw new PtcPythonError(
        "TypeError: object of type 'coroutine' has no len()",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
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
        return [{ name: "code_execution" }];
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    };

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const codeExecutionTool = registered.find((tool) => tool.name === "code_execution");
    assert.ok(codeExecutionTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      codeExecutionTool.execute(
        "call-1",
        { code: "path = 'README.md'\ncontent = read(path)\nreturn len(content)" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const firstContext = eventHandlers.get("context")({
      messages: [{ role: "user", content: [{ type: "text", text: "Analyze files" }] }],
    });
    assert.equal(firstContext.messages.length, 2);
    assert.deepEqual(firstContext.messages[1], {
      role: "custom",
      customType: "ptc-recovery",
      content: recoveryPrompt,
      display: true,
      timestamp: firstContext.messages[1].timestamp,
    });
    assert.equal(typeof firstContext.messages[1].timestamp, "number");

    const secondContext = eventHandlers.get("context")({
      messages: [{ role: "user", content: [{ type: "text", text: "Analyze files" }] }],
    });
    assert.equal(secondContext, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreExecutor();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension does not append a second automatic recovery message after recovery was already used", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in recovery lifecycle test");
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
      return [];
    }
  }

  let attempts = 0;
  class FakeCodeExecutor {
    async execute() {
      attempts += 1;
      throw new PtcPythonError(
        "TypeError: 'coroutine' object is not iterable",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
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
        return [{ name: "code_execution" }];
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    };

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const codeExecutionTool = registered.find((tool) => tool.name === "code_execution");
    assert.ok(codeExecutionTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      codeExecutionTool.execute(
        "call-1",
        { code: "paths = sorted(glob('src/**/*.ts'))\nreturn paths[:3]" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const firstContext = eventHandlers.get("context")({ messages: [] });
    assert.equal(firstContext.messages.length, 1);
    assert.equal(firstContext.messages[0].customType, "ptc-recovery");

    await assert.rejects(
      codeExecutionTool.execute(
        "call-2",
        { code: "paths = sorted(glob('src/**/*.ts'))\nreturn paths[:3]" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    assert.equal(attempts, 2);
    const secondContext = eventHandlers.get("context")({ messages: [] });
    assert.equal(secondContext, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreExecutor();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});

test("ptc extension does not auto-recover literal zero-match path failures", async () => {
  const previousAutoRecover = process.env.PTC_AUTO_RECOVER;
  process.env.PTC_AUTO_RECOVER = "true";

  const { PtcPythonError } = require("../dist/execution/execution-errors.js");

  const sandbox = {
    async cleanup() {},
    spawn() {
      throw new Error("sandbox spawn should not be used in zero-match recovery test");
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
      return [];
    }
  }

  class FakeCodeExecutor {
    async execute() {
      throw new PtcPythonError(
        "FileNotFoundError: [Errno 2] No such file or directory: 'src/**/*.missing.ts'",
        'Traceback (most recent call last):\n  File "<stdin>", line 2, in user_main'
      );
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
        return [{ name: "code_execution" }];
      },
      getActiveTools() {
        return [];
      },
      setActiveTools() {},
    };

    await ptcExtension(pi);
    await eventHandlers.get("session_start")({}, { cwd: process.cwd() });

    const codeExecutionTool = registered.find((tool) => tool.name === "code_execution");
    assert.ok(codeExecutionTool);

    eventHandlers.get("before_agent_start")({ prompt: "Analyze files", systemPrompt: "base prompt" });
    await assert.rejects(
      codeExecutionTool.execute(
        "call-1",
        { code: "paths = await glob('src/**/*.missing.ts')\nreturn paths[0]" },
        undefined,
        undefined,
        { cwd: process.cwd() }
      ),
      PtcPythonError
    );

    const contextResult = eventHandlers.get("context")({ messages: [] });
    assert.equal(contextResult, undefined);
  } finally {
    if (previousAutoRecover === undefined) {
      delete process.env.PTC_AUTO_RECOVER;
    } else {
      process.env.PTC_AUTO_RECOVER = previousAutoRecover;
    }
    restoreSandbox();
    restoreManager();
    restoreRegistry();
    restoreExecutor();
    delete require.cache[require.resolve("../dist/index.js")];
  }
});
