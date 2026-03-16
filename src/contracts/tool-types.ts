import type {
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
  ToolInfo as ExtensionToolInfo,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

export type PtcCaller = "direct" | "code_execution";

export interface PtcToolOptions {
  enabled?: boolean;
  readOnly?: boolean;
  pythonName?: string;
  callers?: PtcCaller[];
}

export type PtcToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
> = ToolDefinition<TParams, TDetails> & {
  ptc?: PtcToolOptions;
};

export interface LoadedTool {
  tool: PtcToolDefinition;
  filename: string;
}

export type ToolSource = "builtin" | "alias" | "extension";

export interface ToolInfo extends ExtensionToolInfo {
  execute: ToolDefinition["execute"];
  source: ToolSource;
  isReadOnly: boolean;
  ptc?: PtcToolOptions;
}

export interface CallerMetadata {
  type: "code_execution";
  parentToolCallId?: string;
  nestedCallId: string;
}

export interface ExecuteToolContext {
  ctx: ExtensionContext;
  signal?: AbortSignal;
  caller?: CallerMetadata;
}

export type ToolUpdateCallback = AgentToolUpdateCallback<unknown>;
