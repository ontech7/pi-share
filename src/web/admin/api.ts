import type {
  BrowseResult,
  CreateLinkBody,
  LinkDetail,
  LinkSummary,
  ServiceState,
  SessionState,
  UpdateLinkBody,
} from '../../shared/api.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly data: Record<string, unknown>;

  constructor(status: number, data: Record<string, unknown>) {
    super(String(data.error ?? status));
    this.status = status;
    this.code = String(data.error ?? 'unknown');
    this.data = data;
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method === 'GET' ? {} : { 'x-pi-share': '1' }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}

export const api = {
  session: () => request<SessionState>('GET', '/api/session'),
  setup: (code: string, password: string) => request('POST', '/api/setup', { code, password }),
  login: (password: string) => request('POST', '/api/login', { password }),
  logout: () => request('POST', '/api/logout'),
  changePassword: (current: string, password: string) => request('POST', '/api/password', { current, password }),
  service: () => request<ServiceState>('GET', '/api/service'),
  updateService: (patch: Partial<Pick<ServiceState, 'enabled' | 'autoOff'>>) =>
    request<ServiceState>('PATCH', '/api/service', patch),
  browse: (path: string) => request<BrowseResult>('GET', `/api/browse?path=${encodeURIComponent(path)}`),
  links: () => request<LinkSummary[]>('GET', '/api/links'),
  link: (id: string) => request<LinkDetail>('GET', `/api/links/${id}`),
  createLink: (body: CreateLinkBody) => request<LinkDetail>('POST', '/api/links', body),
  updateLink: (id: string, patch: UpdateLinkBody) => request<LinkDetail>('PATCH', `/api/links/${id}`, patch),
  deleteLink: (id: string) => request<void>('DELETE', `/api/links/${id}`),
};

export const keys = {
  session: ['session'] as const,
  service: ['service'] as const,
  links: ['links'] as const,
  link: (id: string) => ['links', id] as const,
  browse: (path: string) => ['browse', path] as const,
};
