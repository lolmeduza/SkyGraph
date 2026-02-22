export interface PanelState {
  openIds: string[];
  activeId: string;
}

export interface ChatMessage {
  role: string;
  text: string;
}

export interface ChatState {
  id: string;
  name: string;
  messages: ChatMessage[];
}

export interface HistoryIndex {
  chats: { id: string; name: string }[];
}
