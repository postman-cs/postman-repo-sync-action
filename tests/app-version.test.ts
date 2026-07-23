import { describe, expect, it, vi } from 'vitest';

import { PostmanAppVersionProvider } from '../src/lib/postman/app-version.js';

describe('PostmanAppVersionProvider', () => {
  it('memoizes a valid remote version', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ version: '12.21.1-rc1' }), { status: 200 })
    );
    const provider = new PostmanAppVersionProvider({ fetchImpl });

    await expect(Promise.all([provider.get(), provider.get()])).resolves.toEqual([
      '12.21.1-rc1',
      '12.21.1-rc1'
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the floor version when lookup fails', async () => {
    const provider = new PostmanAppVersionProvider({
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    });
    await expect(provider.get()).resolves.toBe('12.0.0');
  });
});
