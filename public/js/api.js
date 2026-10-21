export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, options = {}) {
  const { body, headers, ...rest } = options;
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      headers: {
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...rest,
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Can’t reach the MoveSafe desk. Check your connection and try again.', 0);
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    throw new ApiError(data?.error || 'Request failed.', response.status);
  }
  return data;
}

export async function currentStaff() {
  const response = await fetch('/api/me', { credentials: 'same-origin' });
  if (!response.ok) return null;
  return response.json();
}
