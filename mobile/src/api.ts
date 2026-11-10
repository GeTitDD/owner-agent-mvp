import type {
  ChatResult, Idea, Overview, PairResult
} from './types';

export interface ServerConfig {
  baseUrl: string;
  token: string;
}

const normalize = (url: string) => url.trim().replace(/\/+$/u, '');

async function request<T>(
  config: ServerConfig,
  path: string,
  init: RequestInit = {},
  timeoutMs = 20000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalize(config.baseUrl)}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        ...(init.headers ?? {})
      }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(String(data?.error ?? `HTTP ${response.status}`));
    }
    return data as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求超时，请检查手机和电脑是否在同一 Wi-Fi');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function pair(baseUrl: string, code: string, deviceName: string): Promise<PairResult> {
  return request<PairResult>(
    { baseUrl, token: '' },
    '/m/pair',
    { method: 'POST', body: JSON.stringify({ code, deviceName }) },
    15000
  );
}

export async function health(baseUrl: string): Promise<{ ok: boolean; version: string }> {
  return request<{ ok: boolean; version: string }>({ baseUrl, token: '' }, '/m/health', {}, 8000);
}

export async function getOverview(config: ServerConfig, projectId = ''): Promise<Overview> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request<Overview>(config, `/m/overview${query}`);
}

export async function sendChat(
  config: ServerConfig,
  projectId: string,
  text: string
): Promise<ChatResult> {
  return request<ChatResult>(
    config,
    '/m/chat',
    { method: 'POST', body: JSON.stringify({ projectId, text }) },
    180000
  );
}

export async function addIdea(
  config: ServerConfig,
  projectId: string,
  title: string,
  body = ''
): Promise<Idea> {
  return request<Idea>(config, '/m/ideas', {
    method: 'POST',
    body: JSON.stringify({ projectId, title, body })
  });
}

export async function setIdeaStatus(
  config: ServerConfig,
  id: string,
  status: Idea['status']
): Promise<Idea> {
  return request<Idea>(config, `/m/ideas/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  });
}

export async function removeIdea(config: ServerConfig, id: string): Promise<{ removed: string }> {
  return request<{ removed: string }>(config, `/m/ideas/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
}
