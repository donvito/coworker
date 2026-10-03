/** The OpenAI access method currently selected for this app profile. */
export type OpenAIAuthMode = "api-key" | "chatgpt-subscription";

/** Safe account details for the renderer; credential values never cross IPC. */
export interface ChatGPTAccount {
  id: string;
  label: string;
  email?: string;
  connected: boolean;
  planUsageEnabled: boolean;
}

export interface ChatGPTAuthStatus {
  mode: OpenAIAuthMode;
  state: "disconnected" | "waiting" | "connected" | "sign-in-required";
  activeAccountId: string | null;
  accounts: ChatGPTAccount[];
  welcomeSeen: boolean;
}
