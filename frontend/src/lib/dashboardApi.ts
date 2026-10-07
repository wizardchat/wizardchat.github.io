import { request } from './chatApi';
import type { ChatDashboard, DashboardConfig, DashboardRunResult } from './types';

export async function getDashboard(chatId: string): Promise<{ dashboard: ChatDashboard }> {
  return request<{ dashboard: ChatDashboard }>(`/chats/${encodeURIComponent(chatId)}/dashboard`);
}

export async function saveDashboard(
  chatId: string,
  payload: { iconUrl?: string | null; blocks: DashboardConfig },
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/chats/${encodeURIComponent(chatId)}/dashboard`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function deleteDashboard(chatId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/chats/${encodeURIComponent(chatId)}/dashboard`, {
    method: 'DELETE',
  });
}

export async function runDashboardRow(chatId: string, rowId: string): Promise<DashboardRunResult> {
  return request<DashboardRunResult>(`/chats/${encodeURIComponent(chatId)}/dashboard/run`, {
    method: 'POST',
    body: JSON.stringify({ rowId }),
  });
}