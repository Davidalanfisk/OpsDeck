export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserState = { origin: string; loading: boolean; failed: boolean; canGoBack: boolean; canGoForward: boolean };
export type BrowserAction = 'back' | 'forward' | 'reload' | 'external';

export type DesktopBridge = {
  updateStatus: () => Promise<UpdateStatus>;
  updateCheck: () => Promise<void>;
  updatePrepare: () => Promise<void>;
  updateRestart: () => Promise<void>;
  open: (id: string, clientId: string, url: string) => Promise<void>;
  release: (id: string) => void;
  layout: (id: string, bounds: BrowserBounds | null) => void;
  action: (id: string, action: BrowserAction) => Promise<void>;
  onState: (id: string, notify: (state: BrowserState) => void) => () => void;
  ollamaStatus: () => Promise<OllamaStatus>;
  ollamaSetup: (model: OllamaModel) => Promise<void>;
  agentChat: (messages: AgentMessage[], tools: AgentTool[], contextSize: number) => Promise<AgentChatResult>;
  agentCancel: () => void;
  agentWebsiteAccess: (clientId: string | null) => Promise<void>;
  agentWebsite: (id: string, action: 'inspect' | 'click' | 'type', index?: number, value?: string) => Promise<string>;
};
import type { AgentChatResult, AgentMessage, AgentTool, OllamaModel, OllamaStatus } from './ollama.ts';
import type { UpdateStatus } from './update.ts';
