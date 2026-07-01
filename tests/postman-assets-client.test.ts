import { describe, expect, it, vi } from 'vitest';

import { PostmanAssetsClient } from '../src/lib/postman/postman-assets-client.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

describe('PostmanAssetsClient (read-only /me only)', () => {
  it('defaults baseUrl to the Postman prod API and calls GET /me through it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ user: { id: 'user-1' } })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    await client.getMe();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.getpostman.com/me',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('honors a custom baseUrl override for beta stacks', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ user: { id: 'user-1' } })
    );
    const client = new PostmanAssetsClient({
      apiKey: 'pmak-beta',
      baseUrl: 'https://api.getpostman-beta.com/',
      fetchImpl
    });
    await client.getMe();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.getpostman-beta.com/me',
      expect.any(Object)
    );
  });

  it('returns the user object from the API', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ user: { id: 'user-123', name: 'Test User', teamId: 12345 } })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const result = await client.getMe();
    expect(result).toEqual({ user: { id: 'user-123', name: 'Test User', teamId: 12345 } });
  });

  it('returns null when the response has no body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-test', fetchImpl });
    const result = await client.getMe();
    expect(result).toBeNull();
  });

  it('throws an HttpError on a non-2xx response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('unauthorized', { status: 401, statusText: 'Unauthorized' })
    );
    const client = new PostmanAssetsClient({ apiKey: 'pmak-bad', fetchImpl });
    await expect(client.getMe()).rejects.toThrow('401');
  });
});
