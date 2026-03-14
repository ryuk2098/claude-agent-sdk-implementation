import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Chat, ConversationTurn, AgentStep, TurnSegment, SessionListItem } from '../types';
import { fetchSessions, fetchSessionHistory } from '../api/sessions';

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

interface ChatStore {
  // Active chat state (in-memory, for current session)
  chats: Chat[];
  activeChatId: string | null;
  showArtifacts: boolean;
  artifactTitle: string;
  artifactContent: string;
  sidebarCollapsed: boolean;

  // Sidebar session list (from API)
  sessionList: SessionListItem[];
  sessionListPage: number;
  sessionListHasMore: boolean;
  isLoadingSessions: boolean;

  // Per-chat history pagination
  historyPageMap: Record<string, number>;       // sessionId → next page to load
  historyHasMoreMap: Record<string, boolean>;   // sessionId → has more pages
  isLoadingHistory: boolean;

  // Actions — chat management
  createChat: () => Chat;
  setActiveChat: (id: string) => void;
  updateChatSession: (chatId: string, sessionId: string) => void;
  updateChatTitle: (chatId: string, title: string) => void;
  addTurn: (chatId: string, turn: ConversationTurn) => void;
  updateTurn: (chatId: string, turnId: string, updates: Partial<ConversationTurn>) => void;
  deleteLocalChat: (chatId: string) => void;
  removeSessionFromList: (sessionId: string) => void;

  // Actions — segment-based streaming
  addSegment: (chatId: string, turnId: string, segment: TurnSegment) => void;
  addStepToSegment: (chatId: string, turnId: string, segmentId: string, step: AgentStep) => void;
  updateStepInSegment: (chatId: string, turnId: string, segmentId: string, stepId: string, updates: Partial<AgentStep>) => void;
  appendTextToSegment: (chatId: string, turnId: string, segmentId: string, text: string) => void;
  updateSegment: (chatId: string, turnId: string, segmentId: string, updates: Partial<TurnSegment>) => void;
  toggleSegmentStepsCollapsed: (chatId: string, turnId: string, segmentId: string) => void;

  // Actions — artifacts
  setShowArtifacts: (show: boolean) => void;
  setArtifact: (title: string, content: string) => void;

  // Actions — sidebar
  toggleSidebar: () => void;

  // Actions — API-driven session list
  loadSessions: (reset?: boolean) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  refreshSessionInList: (sessionId: string, title: string) => void;

  // Actions — history loading
  loadHistoryForSession: (chatId: string, sessionId: string) => Promise<void>;
  loadMoreHistory: (chatId: string, sessionId: string) => Promise<void>;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      chats: [],
      activeChatId: null,
      showArtifacts: false,
      artifactTitle: '',
      artifactContent: '',
      sidebarCollapsed: false,

      sessionList: [],
      sessionListPage: 0,
      sessionListHasMore: true,
      isLoadingSessions: false,

      historyPageMap: {},
      historyHasMoreMap: {},
      isLoadingHistory: false,

      // ── Chat management ───────────────────────────────────────

      createChat: () => {
        const now = new Date().toISOString();
        const chat: Chat = {
          id: generateId(),
          sessionId: null,
          title: 'New Chat',
          turns: [],
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          chats: [chat, ...state.chats],
          activeChatId: chat.id,
          showArtifacts: false,
          artifactContent: '',
          artifactTitle: '',
        }));
        return chat;
      },

      setActiveChat: (id) => {
        set({
          activeChatId: id,
          showArtifacts: false,
          artifactContent: '',
          artifactTitle: '',
        });
      },

      updateChatSession: (chatId, sessionId) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId ? { ...c, sessionId, updatedAt: new Date().toISOString() } : c
          ),
        }));
      },

      updateChatTitle: (chatId, title) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId ? { ...c, title, updatedAt: new Date().toISOString() } : c
          ),
        }));
      },

      addTurn: (chatId, turn) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId
              ? { ...c, turns: [...c.turns, turn], updatedAt: new Date().toISOString() }
              : c
          ),
        }));
      },

      updateTurn: (chatId, turnId, updates) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  turns: c.turns.map((t) => (t.id === turnId ? { ...t, ...updates } : t)),
                  updatedAt: new Date().toISOString(),
                }
              : c
          ),
        }));
      },

      deleteLocalChat: (chatId) => {
        set((state) => {
          const remaining = state.chats.filter((c) => c.id !== chatId);
          return {
            chats: remaining,
            activeChatId:
              state.activeChatId === chatId
                ? remaining[0]?.id ?? null
                : state.activeChatId,
          };
        });
      },

      removeSessionFromList: (sessionId) => {
        set((state) => ({
          sessionList: state.sessionList.filter((s) => s.session_id !== sessionId),
          chats: state.chats.filter((c) => c.sessionId !== sessionId),
          activeChatId: state.chats.find((c) => c.sessionId === sessionId)?.id === state.activeChatId
            ? (state.chats.filter((c) => c.sessionId !== sessionId)[0]?.id ?? null)
            : state.activeChatId,
        }));
      },

      // ── Segment-based streaming ───────────────────────────────

      addSegment: (chatId, turnId, segment) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  turns: c.turns.map((t) =>
                    t.id === turnId
                      ? { ...t, segments: [...t.segments, segment] }
                      : t
                  ),
                }
              : c
          ),
        }));
      },

      addStepToSegment: (chatId, turnId, segmentId, step) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  turns: c.turns.map((t) =>
                    t.id === turnId
                      ? {
                          ...t,
                          segments: t.segments.map((s) =>
                            s.id === segmentId
                              ? { ...s, steps: [...s.steps, step] }
                              : s
                          ),
                        }
                      : t
                  ),
                }
              : c
          ),
        }));
      },

      updateStepInSegment: (chatId, turnId, segmentId, stepId, updates) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  turns: c.turns.map((t) =>
                    t.id === turnId
                      ? {
                          ...t,
                          segments: t.segments.map((s) =>
                            s.id === segmentId
                              ? {
                                  ...s,
                                  steps: s.steps.map((st) =>
                                    st.id === stepId ? { ...st, ...updates } : st
                                  ),
                                }
                              : s
                          ),
                        }
                      : t
                  ),
                }
              : c
          ),
        }));
      },

      appendTextToSegment: (chatId, turnId, segmentId, text) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  turns: c.turns.map((t) =>
                    t.id === turnId
                      ? {
                          ...t,
                          segments: t.segments.map((s) =>
                            s.id === segmentId ? { ...s, text: s.text + text } : s
                          ),
                        }
                      : t
                  ),
                }
              : c
          ),
        }));
      },

      updateSegment: (chatId, turnId, segmentId, updates) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  turns: c.turns.map((t) =>
                    t.id === turnId
                      ? {
                          ...t,
                          segments: t.segments.map((s) =>
                            s.id === segmentId ? { ...s, ...updates } : s
                          ),
                        }
                      : t
                  ),
                }
              : c
          ),
        }));
      },

      toggleSegmentStepsCollapsed: (chatId, turnId, segmentId) => {
        set((state) => ({
          chats: state.chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  turns: c.turns.map((t) =>
                    t.id === turnId
                      ? {
                          ...t,
                          segments: t.segments.map((s) =>
                            s.id === segmentId
                              ? { ...s, stepsCollapsed: !s.stepsCollapsed }
                              : s
                          ),
                        }
                      : t
                  ),
                }
              : c
          ),
        }));
      },

      // ── Artifacts ─────────────────────────────────────────────

      setShowArtifacts: (show) => set({ showArtifacts: show }),

      setArtifact: (title, content) =>
        set({ artifactTitle: title, artifactContent: content, showArtifacts: true }),

      // ── Sidebar ───────────────────────────────────────────────

      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      // ── API-driven session list ───────────────────────────────

      loadSessions: async (reset = false) => {
        const state = get();
        if (state.isLoadingSessions) return;
        if (!reset && !state.sessionListHasMore) return;

        set({ isLoadingSessions: true });
        try {
          const page = reset ? 1 : state.sessionListPage + 1;
          const data = await fetchSessions(page, 20);
          set((s) => ({
            sessionList: reset ? data.sessions : [...s.sessionList, ...data.sessions],
            sessionListPage: data.page,
            sessionListHasMore: data.has_more,
            isLoadingSessions: false,
          }));
        } catch (err) {
          console.error('Failed to load sessions:', err);
          set({ isLoadingSessions: false });
        }
      },

      loadMoreSessions: async () => {
        const state = get();
        if (!state.sessionListHasMore || state.isLoadingSessions) return;
        await state.loadSessions(false);
      },

      refreshSessionInList: (sessionId, title) => {
        set((state) => ({
          sessionList: state.sessionList.map((s) =>
            s.session_id === sessionId
              ? { ...s, title, updated_at: new Date().toISOString() }
              : s
          ),
        }));
      },

      // ── History loading ───────────────────────────────────────

      loadHistoryForSession: async (chatId, sessionId) => {
        const state = get();
        if (state.isLoadingHistory) return;

        set({ isLoadingHistory: true });
        try {
          const data = await fetchSessionHistory(sessionId, 1, 20);
          const turns = historyToTurns(data.history);

          set((s) => ({
            chats: s.chats.map((c) =>
              c.id === chatId ? { ...c, turns } : c
            ),
            historyPageMap: { ...s.historyPageMap, [sessionId]: 1 },
            historyHasMoreMap: { ...s.historyHasMoreMap, [sessionId]: data.has_more },
            isLoadingHistory: false,
          }));
        } catch (err) {
          console.error('Failed to load history:', err);
          set({ isLoadingHistory: false });
        }
      },

      loadMoreHistory: async (chatId, sessionId) => {
        const state = get();
        if (state.isLoadingHistory) return;
        if (!state.historyHasMoreMap[sessionId]) return;

        const nextPage = (state.historyPageMap[sessionId] ?? 1) + 1;
        set({ isLoadingHistory: true });

        try {
          const data = await fetchSessionHistory(sessionId, nextPage, 20);
          const newTurns = historyToTurns(data.history);

          set((s) => {
            const chat = s.chats.find((c) => c.id === chatId);
            if (!chat) return s;
            return {
              chats: s.chats.map((c) =>
                c.id === chatId
                  ? { ...c, turns: [...newTurns, ...c.turns] }
                  : c
              ),
              historyPageMap: { ...s.historyPageMap, [sessionId]: nextPage },
              historyHasMoreMap: { ...s.historyHasMoreMap, [sessionId]: data.has_more },
              isLoadingHistory: false,
            };
          });
        } catch (err) {
          console.error('Failed to load more history:', err);
          set({ isLoadingHistory: false });
        }
      },
    }),
    {
      name: 'claude-agent-ui',
      partialize: (state) => ({
        chats: state.chats.slice(0, 50).map((c) => ({ ...c, turns: [] })),
        activeChatId: state.activeChatId,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    }
  )
);

// ---------------------------------------------------------------------------
// Helper: convert flat history entries into paired ConversationTurns
// ---------------------------------------------------------------------------
function historyToTurns(history: { role: string; content: string; timestamp: string }[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (entry.role === 'user') {
      const next = history[i + 1];
      const agentText =
        next && (next.role === 'assistant' || next.role === 'error')
          ? next.content
          : '';
      if (next && (next.role === 'assistant' || next.role === 'error')) {
        i++;
      }

      const segment: TurnSegment = {
        id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
        steps: [],
        stepsCollapsed: false,
        text: agentText,
      };

      turns.push({
        id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
        userMessage: entry.content,
        userFiles: [],
        segments: [segment],
        isStreaming: false,
        streamPhase: 'done',
        filesCreated: [],
        error: next?.role === 'error' ? next.content : undefined,
        timestamp: new Date(entry.timestamp),
        fromHistory: true,
      });
    }
  }

  return turns;
}
