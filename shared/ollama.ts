export const ollamaModels = ['qwen3:4b', 'qwen3:8b', 'qwen3:14b', 'qwen3:30b-a3b'] as const;
export type OllamaModel = typeof ollamaModels[number];
export type OllamaStatus = {
  phase: 'idle' | 'downloading' | 'extracting' | 'starting' | 'pulling' | 'ready' | 'error';
  detail: string;
  progress?: number;
  memoryBytes: number;
  recommended: OllamaModel;
  model?: OllamaModel;
};
export type AgentToolCall = { function: { name: string; arguments: Record<string, unknown> } };
export type AgentMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: AgentToolCall[];
  tool_name?: string;
};
export type AgentTool = {
  type: 'function';
  function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] } };
};
export type AgentChatResult = {
  message: AgentMessage;
  diagnostics: {
    configuredContext: number;
    loadedContext?: number;
    promptBytes: number;
    responseBytes: number;
    estimatedTokens: number;
    promptTokens?: number;
    responseTokens?: number;
  };
};
