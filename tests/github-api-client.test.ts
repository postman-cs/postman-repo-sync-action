import { describe, expect, it, vi } from 'vitest';

import {
  GitHubApiClient,
  type GitHubApiClientAuthMode
} from '../src/lib/github/github-api-client.js';
import { createSecretMasker } from '../src/lib/secrets.js';

function jsonResponse(
  body: unknown,
  init: ResponseInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  });
}

describe('GitHubApiClient', () => {
  it('falls back to the fallback token for repo variable writes after a 403', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('', { status: 201 }));

    const client = new GitHubApiClient({
      repository: 'postman-cs/repo-sync-demo',
      token: 'primary-token',
      fallbackToken: 'fallback-token',
      fetch: fetchMock
    });

    await client.setRepositoryVariable('POSTMAN_WORKSPACE_ID', 'ws_123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/postman-cs/repo-sync-demo/actions/variables'
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer primary-token'
      })
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer fallback-token'
      })
    });
  });

  it.each<[GitHubApiClientAuthMode, string[]]>([
    ['github_token_first', ['primary-token', 'fallback-token']],
    ['fallback_pat_first', ['fallback-token', 'primary-token']],
    ['app_token', ['app-token', 'primary-token', 'fallback-token']]
  ])('exposes explicit token ordering for %s', (authMode, expected) => {
    const client = new GitHubApiClient({
      repository: 'postman-cs/repo-sync-demo',
      token: 'primary-token',
      fallbackToken: 'fallback-token',
      appToken: 'app-token',
      authMode
    });

    expect(client.getTokenOrder()).toEqual(expected);
  });

  it('sanitizes GitHub API error messages before surfacing them', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          message:
            'workflow write denied for token fallback-token and bearer primary-token'
        },
        { status: 500, statusText: 'Internal Server Error' }
      )
    );
    const masker = createSecretMasker(['primary-token', 'fallback-token']);
    const client = new GitHubApiClient({
      repository: 'postman-cs/repo-sync-demo',
      token: 'primary-token',
      fallbackToken: 'fallback-token',
      fetch: fetchMock,
      secretMasker: masker
    });

    await expect(
      client.getRepositoryVariable('POSTMAN_WORKSPACE_ID')
    ).rejects.toThrow(
      'GET /repos/postman-cs/repo-sync-demo/actions/variables/POSTMAN_WORKSPACE_ID failed with 500 Internal Server Error'
    );
    await expect(
      client.getRepositoryVariable('POSTMAN_WORKSPACE_ID')
    ).rejects.not.toThrow('primary-token');
    await expect(
      client.getRepositoryVariable('POSTMAN_WORKSPACE_ID')
    ).rejects.not.toThrow('fallback-token');
    await expect(
      client.getRepositoryVariable('POSTMAN_WORKSPACE_ID')
    ).rejects.toThrow('[REDACTED]');
  });
});
