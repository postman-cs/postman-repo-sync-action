import { describe, expect, it } from 'vitest';

import { detectRepoContext } from '../src/lib/repo/context.js';

describe('repository provider detection', () => {
  it.each([
    'https://github.attacker.example/acme/repo',
    'https://github.com.evil.test/acme/repo',
    'https://evil.test/github/acme/repo'
  ])('does not classify substring lookalikes as GitHub: %s', (repoUrl) => {
    expect(detectRepoContext({ repoUrl }, {}).provider).toBe('unknown');
  });

  it('still recognizes exact public provider hosts', () => {
    expect(detectRepoContext({ repoUrl: 'https://github.com/acme/repo' }, {}).provider).toBe('github');
    expect(detectRepoContext({ repoUrl: 'https://dev.azure.com/acme/project/_git/repo' }, {}).provider).toBe('azure-devops');
  });
});
