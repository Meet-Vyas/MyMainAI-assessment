import type {
  AuthUser,
  InitUploadRequest,
  InitUploadResponse,
  LoginRequest,
  SignPartsResponse,
  ThumbnailUploadRequest,
  ThumbnailUploadResponse,
  UpdateVideoRequest,
  UploadStatusResponse,
  VideoDto,
} from '@ugn/contracts';

/** status 0 means the request never got a response (offline, DNS, connection reset). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

let onUnauthorized: () => void = () => undefined;
/** Lets the auth layer react (redirect to login) when any call finds the session expired. */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

/** Pulls a readable message out of a Nest error body, including zod field errors. */
function messageFrom(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as { message?: unknown; errors?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } };
  const fieldError = Object.values(b.errors?.fieldErrors ?? {})[0]?.[0] ?? b.errors?.formErrors?.[0];
  if (fieldError) return fieldError;
  if (typeof b.message === 'string') return b.message;
  if (Array.isArray(b.message) && typeof b.message[0] === 'string') return b.message[0];
  return fallback;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, null, 'Network error. Check your connection.');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') onUnauthorized();
    throw new ApiError(res.status, data, messageFrom(data, res.statusText || `Request failed (${res.status})`));
  }
  return data as T;
}

export const api = {
  me: () => request<AuthUser>('GET', '/auth/me'),
  login: (body: LoginRequest) => request<AuthUser>('POST', '/auth/login', body),
  logout: () => request<void>('POST', '/auth/logout'),

  listVideos: () => request<VideoDto[]>('GET', '/admin/videos'),
  getVideo: (id: string) => request<VideoDto>('GET', `/admin/videos/${id}`),
  updateVideo: (id: string, body: UpdateVideoRequest) => request<VideoDto>('PATCH', `/admin/videos/${id}`, body),
  deleteVideo: (id: string) => request<void>('DELETE', `/admin/videos/${id}`),
  retryVideo: (id: string) => request<VideoDto>('POST', `/admin/videos/${id}/retry`),

  initUpload: (body: InitUploadRequest) => request<InitUploadResponse>('POST', '/admin/uploads', body),
  uploadStatus: (id: string) => request<UploadStatusResponse>('GET', `/admin/uploads/${id}`),
  signParts: (id: string, partNumbers: number[]) =>
    request<SignPartsResponse>('POST', `/admin/uploads/${id}/parts`, { partNumbers }),
  completeUpload: (id: string) => request<VideoDto>('POST', `/admin/uploads/${id}/complete`),
  thumbnailUpload: (id: string, body: ThumbnailUploadRequest) =>
    request<ThumbnailUploadResponse>('POST', `/admin/uploads/${id}/thumbnail`, body),
};
