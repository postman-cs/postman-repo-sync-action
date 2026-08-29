import { describe, expect, it } from 'vitest';

import {
  countManagedItemAuthBlocks,
  MANAGED_ITEM_AUTH_BLOCKS,
  PRIVATE_MOCK_AUTH_ROOT_MARKER,
  PRIVATE_MOCK_AUTH_ROOT_SCRIPT,
  PRIVATE_MOCK_AUTH_VARIABLE,
  stripManagedItemAuthBlocks
} from '../src/lib/postman/private-mock-auth-script.js';

describe('PRIVATE_MOCK_AUTH_ROOT_SCRIPT', () => {
  it('is secret-free and only reads pm.variables.get(PRIVATE_MOCK_AUTH_VARIABLE)', () => {
    expect(PRIVATE_MOCK_AUTH_ROOT_SCRIPT).toContain(
      `pm.variables.get('${PRIVATE_MOCK_AUTH_VARIABLE}')`
    );
    expect(PRIVATE_MOCK_AUTH_ROOT_SCRIPT).toContain(PRIVATE_MOCK_AUTH_ROOT_MARKER);
    expect(PRIVATE_MOCK_AUTH_ROOT_SCRIPT).not.toMatch(/pmak-[a-z0-9]+/i);
    expect(PRIVATE_MOCK_AUTH_ROOT_SCRIPT).not.toMatch(/PMAK-[A-Za-z0-9]+/);
    expect(PRIVATE_MOCK_AUTH_ROOT_SCRIPT).not.toMatch(/['"][a-f0-9]{32,}['"]/i);
    expect(PRIVATE_MOCK_AUTH_ROOT_SCRIPT).not.toMatch(/api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i);
    const gets = [...PRIVATE_MOCK_AUTH_ROOT_SCRIPT.matchAll(/pm\.variables\.get\(([^)]*)\)/g)].map(
      (match) => match[1]
    );
    expect(gets).toEqual([`'${PRIVATE_MOCK_AUTH_VARIABLE}'`]);
  });

  it('host guard matches x.mock.pstmn.io and rejects mock.pstmn.io.evil.com', () => {
    const match = PRIVATE_MOCK_AUTH_ROOT_SCRIPT.match(/\/\(\^\|\\\.\)mock\\\.pstmn\\\.io\$\/i/);
    expect(match?.[0]).toBeTruthy();
    const hostRe = new RegExp(match![0].slice(1, match![0].lastIndexOf('/')), 'i');
    expect(hostRe.test('x.mock.pstmn.io')).toBe(true);
    expect(hostRe.test('abc.mock.pstmn.io')).toBe(true);
    expect(hostRe.test('mock.pstmn.io')).toBe(true);
    expect(hostRe.test('mock.pstmn.io.evil.com')).toBe(false);
    expect(hostRe.test('evilmock.pstmn.io.attacker.test')).toBe(false);
  });
});

describe('stripManagedItemAuthBlocks', () => {
  it.each(['v1', 'v2', 'v3'] as const)('removes the byte-exact %s managed block', (version) => {
    const index = version === 'v1' ? 0 : version === 'v2' ? 1 : 2;
    const block = MANAGED_ITEM_AUTH_BLOCKS[index] ?? '';
    const authorLine = 'var callerOwned = true;';
    expect(stripManagedItemAuthBlocks(`${block}\n${authorLine}`)).toBe(authorLine);
    expect(stripManagedItemAuthBlocks(`${authorLine}\n${block}`)).toBe(authorLine);
  });

  it('leaves a customer-edited near-miss untouched', () => {
    const nearMiss = [
      '// postman-enterprise-automation: private-mock-auth-v3-custom',
      "var privateMockApiKey = pm.variables.get('postmanPrivateMockApiKey');"
    ].join('\n');
    expect(stripManagedItemAuthBlocks(nearMiss)).toBe(nearMiss);
  });

  it('leaves a one-character-modified managed block untouched', () => {
    const exact = MANAGED_ITEM_AUTH_BLOCKS[2] ?? '';
    const nearMiss = `${exact.slice(0, 40)}X${exact.slice(41)}`;
    expect(nearMiss).not.toBe(exact);
    expect(stripManagedItemAuthBlocks(nearMiss)).toBe(nearMiss);
    expect(stripManagedItemAuthBlocks(`${nearMiss}\nvar keep = 1;`)).toBe(`${nearMiss}\nvar keep = 1;`);
  });

  it('is idempotent', () => {
    const mixed = `${MANAGED_ITEM_AUTH_BLOCKS[0]}\n${MANAGED_ITEM_AUTH_BLOCKS[2]}\nvar keep = 1;`;
    const once = stripManagedItemAuthBlocks(mixed);
    expect(stripManagedItemAuthBlocks(once)).toBe(once);
    expect(stripManagedItemAuthBlocks(once)).toBe(once);
  });

  it('returns an empty string when the code was managed-only', () => {
    expect(stripManagedItemAuthBlocks(MANAGED_ITEM_AUTH_BLOCKS.join('\n\n'))).toBe('');
    expect(stripManagedItemAuthBlocks('')).toBe('');
    expect(stripManagedItemAuthBlocks(null as unknown as string)).toBe('');
  });

  it('does not remove the collection-root managed block', () => {
    expect(stripManagedItemAuthBlocks(PRIVATE_MOCK_AUTH_ROOT_SCRIPT)).toBe(PRIVATE_MOCK_AUTH_ROOT_SCRIPT);
    const mixed = `${PRIVATE_MOCK_AUTH_ROOT_SCRIPT}\n${MANAGED_ITEM_AUTH_BLOCKS[2]}\nvar keep = 1;`;
    const stripped = stripManagedItemAuthBlocks(mixed);
    expect(stripped).toBe(`${PRIVATE_MOCK_AUTH_ROOT_SCRIPT}\nvar keep = 1;`);
    expect(stripped).toContain(PRIVATE_MOCK_AUTH_ROOT_SCRIPT);
    expect(stripped).not.toContain(MANAGED_ITEM_AUTH_BLOCKS[2] ?? 'missing-v3-block');
  });

  it('does not leave a blank-line seam after deleting a middle managed block', () => {
    const block = MANAGED_ITEM_AUTH_BLOCKS[2] ?? '';
    const input = `var a = 1;\n${block}\nvar b = 2;`;
    const once = stripManagedItemAuthBlocks(input);
    expect(once).toBe('var a = 1;\nvar b = 2;');
    expect(once).not.toContain('\n\n');
    expect(stripManagedItemAuthBlocks(once)).toBe(once);
  });

  it('leaves an exact managed block inside a template literal unchanged', () => {
    const block = MANAGED_ITEM_AUTH_BLOCKS[2] ?? '';
    const input = `const doc = \`${block}\`;\nvar keep = 1;`;
    expect(stripManagedItemAuthBlocks(input)).toBe(input);
  });

  it('leaves an exact managed block inside a nested template interpolation string unchanged', () => {
    const block = MANAGED_ITEM_AUTH_BLOCKS[2] ?? '';
    const input = `const doc = \`outer \${\`inner\n${block}\nvalue\`} tail\`;\nvar keep = 1;`;
    expect(stripManagedItemAuthBlocks(input)).toBe(input);
    expect(countManagedItemAuthBlocks(input)).toBe(0);
  });

  it.each([
    "var matcher = /don't/;",
    'var matcher = /"quoted"/;',
    String.raw`var matcher = /['"]/;`
  ])('removes a managed block after a regex literal containing quotes: %s', (customerCode) => {
    const block = MANAGED_ITEM_AUTH_BLOCKS[2] ?? '';
    const input = `${customerCode}\n${block}`;

    expect(countManagedItemAuthBlocks(input)).toBe(1);
    expect(stripManagedItemAuthBlocks(input)).toBe(customerCode);
  });

  it('does not mistake division for a regex literal before a managed block', () => {
    const block = MANAGED_ITEM_AUTH_BLOCKS[2] ?? '';
    const customerCode = 'var average = 10 / 2;';
    const input = `${customerCode}\n${block}`;

    expect(countManagedItemAuthBlocks(input)).toBe(1);
    expect(stripManagedItemAuthBlocks(input)).toBe(customerCode);
  });

  it('preserves unrelated triple newlines, trailing spaces, and trailing newline when removing a real block elsewhere', () => {
    const block = MANAGED_ITEM_AUTH_BLOCKS[0] ?? '';
    const input = `${block}\n\n\nvar keep = 1;  \n`;
    expect(stripManagedItemAuthBlocks(input)).toBe('\n\nvar keep = 1;  \n');
  });
});
