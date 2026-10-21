import { create } from "zustand";
import type {
  AlertItem,
  CreateScheduleRequest,
  ScheduleItem,
  UpdateScheduleRequest,
} from "@autonotice/shared";
import { api } from "../services/api";

interface ScheduleState {
  items: ScheduleItem[];
  alerts: AlertItem[];
  loading: boolean;
  alertsLoading: boolean;
  error: string | null;
  alertsError: string | null;
  fetchSchedules: () => Promise<void>;
  fetchAlerts: () => Promise<void>;
  createSchedule: (input: CreateScheduleRequest) => Promise<ScheduleItem>;
  updateSchedule: (id: number, patch: UpdateScheduleRequest) => Promise<ScheduleItem>;
  deleteSchedule: (id: number) => Promise<void>;
  reset: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

const EMPTY_STATE = {
  items: [] as ScheduleItem[],
  alerts: [] as AlertItem[],
  loading: false,
  alertsLoading: false,
  error: null,
  alertsError: null,
};

export const useScheduleStore = create<ScheduleState>()((set, get) => ({
  ...EMPTY_STATE,

  fetchSchedules: async () => {
    set({ loading: true, error: null });
    try {
      const { items } = await api.listSchedules();
      set({ items, loading: false });
    } catch (error) {
      set({ loading: false, error: messageOf(error) });
    }
  },

  fetchAlerts: async () => {
    set({ alertsLoading: true, alertsError: null });
    try {
      const { items } = await api.listAlerts();
      set({ alerts: items, alertsLoading: false });
    } catch (error) {
      set({ alertsLoading: false, alertsError: messageOf(error) });
    }
  },

  createSchedule: async (input) => {
    const item = await api.createSchedule(input);
    set((state) => ({ items: [...state.items, item] }));
    void get().fetchAlerts();
    return item;
  },

  updateSchedule: async (id, patch) => {
    const item = await api.updateSchedule(id, patch);
    set((state) => ({
      items: state.items.map((current) => (current.id === item.id ? item : current)),
    }));
    // 服务端在修改时间/标题时会同步刷新提醒，这里跟着拉一次。
    void get().fetchAlerts();
    return item;
  },

  deleteSchedule: async (id) => {
    await api.deleteSchedule(id);
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
      alerts: state.alerts.filter((alert) => alert.scheduleId !== id),
    }));
    void get().fetchAlerts();
  },

  reset: () => set({ ...EMPTY_STATE }),
}));
