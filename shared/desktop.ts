export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserState = { origin: string; loading: boolean; failed: boolean; canGoBack: boolean; canGoForward: boolean };
export type BrowserAction = 'back' | 'forward' | 'reload' | 'external';

export type DesktopBridge = {
  open: (id: string, clientId: string, url: string) => Promise<void>;
  release: (id: string) => void;
  layout: (id: string, bounds: BrowserBounds | null) => void;
  action: (id: string, action: BrowserAction) => Promise<void>;
  onState: (id: string, notify: (state: BrowserState) => void) => () => void;
  ollamaStatus: () => Promise<OllamaStatus>;
  ollamaSetup: (model: OllamaModel) => Promise<void>;
  agentChat: (messages: AgentMessage[], tools: AgentTool[]) => Promise<AgentMessage>;
  agentCancel: () => void;
  agentWebsiteAccess: (clientId: string | null) => Promise<void>;
  agentWebsite: (id: string, action: 'inspect' | 'click' | 'type', index?: number, value?: string) => Promise<string>;
};
import type { AgentMessage, AgentTool, OllamaModel, OllamaStatus } from './ollama.ts';
