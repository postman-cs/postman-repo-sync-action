import { describe, expect, it, vi } from 'vitest';

import {
  applyDurableEnvironmentPlan,
  DurableEnvironmentPartialApplyError,
  planDurableEnvironmentsLive,
  planDurableEnvironmentsOffline,
  projectDurableEnvironmentOrphans,
  projectDurableEnvironmentPlan,
  type DurableEnvironmentClient,
  type DurableEnvironmentPlanInput
} from '../src/lib/postman/durable-environment-provisioning.js';
import type {
  DurableEnvironmentPolicy,
  EnvironmentDefinition
} from '../src/lib/postman/environment-definitions.js';

function definition(slug: string, baseUrl = `https://${slug}.example.com`): EnvironmentDefinition {
  return {
    slug,
    values: [
      { key: 'baseUrl', value: baseUrl, type: 'default', enabled: true },
      { key: 'jwtToken', value: '', type: 'secret', enabled: true }
    ]
  };
}

function definitionsFor(...definitions: EnvironmentDefinition[]): Record<string, EnvironmentDefinition> {
  return Object.assign(
    Object.create(null) as Record<string, EnvironmentDefinition>,
    Object.fromEntries(definitions.map((entry) => [entry.slug, entry]))
  );
}

function planInput(overrides: Partial<DurableEnvironmentPlanInput> = {}): DurableEnvironmentPlanInput {
  const dev = definition('dev');
  return {
    workspaceId: 'ws-123',
    projectName: 'Payments API',
    policy: 'create-only',
    environments: ['dev'],
    definitions: definitionsFor(dev),
    explicitUids: Object.create(null) as Record<string, string>,
    trackedBindings: Object.create(null) as DurableEnvironmentPlanInput['trackedBindings'],
    ...overrides
  };
}

function environmentBody(definition: EnvironmentDefinition): { values: EnvironmentDefinition['values'] } {
  return { values: definition.values.map((value) => ({ ...value })) };
}

function createClient(overrides: Partial<DurableEnvironmentClient> = {}) {
  const client = {
    listEnvironments: vi.fn<DurableEnvironmentClient['listEnvironments']>()
      .mockResolvedValue([]),
    createEnvironment: vi.fn<DurableEnvironmentClient['createEnvironment']>()
      .mockResolvedValue('uid-created'),
    updateEnvironment: vi.fn<DurableEnvironmentClient['updateEnvironment']>()
      .mockResolvedValue(undefined),
    getEnvironment: vi.fn<DurableEnvironmentClient['getEnvironment']>()
      .mockResolvedValue({ values: [] }),
    ...overrides
  };
  return client;
}

describe('durable environment planner', () => {
  it('projects an offline unresolved plan without definition values', () => {
    const input = planInput();
    const plan = planDurableEnvironmentsOffline(input);
    const projected = projectDurableEnvironmentPlan(plan);

    expect(plan[0]?.definition.values[0]?.value).toBe('https://dev.example.com');
    expect(projected).toEqual([
      {
        slug: 'dev',
        displayName: 'Payments API - dev',
        action: 'unresolved',
        runtimeSlotKeys: ['jwtToken']
      }
    ]);
    expect(Object.prototype.hasOwnProperty.call(projected[0], 'definition')).toBe(false);
    expect(JSON.stringify(projected)).not.toContain('https://dev.example.com');
    expect(JSON.stringify(projected)).not.toContain('baseUrl');
  });

  it('validates reviewed UID intent during offline planning', () => {
    expect(() => planDurableEnvironmentsOffline(planInput({
      explicitUids: { undeclared: 'uid-other' }
    }))).toThrow(/slug not declared/);

    expect(() => planDurableEnvironmentsOffline(planInput({
      explicitUids: { dev: 'uid-explicit' },
      trackedBindings: {
        dev: { uid: 'uid-tracked', displayName: 'Payments API - dev' }
      }
    }))).toThrow(/conflicting explicit and tracked UIDs/);

    expect(projectDurableEnvironmentPlan(planDurableEnvironmentsOffline(planInput({
      explicitUids: { dev: 'uid-reviewed' }
    })))).toEqual([
      {
        slug: 'dev',
        displayName: 'Payments API - dev',
        action: 'unresolved',
        uid: 'uid-reviewed',
        runtimeSlotKeys: ['jwtToken']
      }
    ]);
  });

  it('reports omitted tracked bindings as retained orphans without deleting them', () => {
    const input = planInput({
      environments: [],
      definitions: definitionsFor(),
      trackedBindings: {
        retired: { uid: 'uid-retired', displayName: 'Payments API - retired' }
      }
    });

    expect(projectDurableEnvironmentOrphans(input)).toEqual([
      {
        slug: 'retired',
        displayName: 'Payments API - retired',
        uid: 'uid-retired',
        action: 'retained'
      }
    ]);
  });

  it.each([
    ['create-only', [], {}, 'create'],
    ['create-only', [{ name: 'Payments API - dev', uid: 'uid-dev' }], { dev: 'uid-dev' }, 'reuse'],
    ['refresh', [{ name: 'Payments API - dev', uid: 'uid-dev' }], { dev: 'uid-dev' }, 'replace']
  ] as const)(
    'plans %s as %s with the matching live identity',
    (policy, live, explicitUids, expectedAction) => {
      const plan = planDurableEnvironmentsLive(
        planInput({ policy, explicitUids }),
        live
      );

      expect(plan[0]?.action).toBe(expectedAction);
      expect(plan[0]?.uid).toBe(expectedAction === 'create' ? undefined : 'uid-dev');
    }
  );

  it('reports an exact-name candidate but refuses implicit adoption', () => {
    expect(() => planDurableEnvironmentsLive(
      planInput(),
      [{ name: 'Payments API - dev', uid: 'uid-unreviewed' }]
    )).toThrow(/untracked exact-name candidate uid-unreviewed.*supply durable-environment-uids-json/);

    expect(planDurableEnvironmentsLive(
      planInput(),
      [{ name: 'Payments API - dev', uid: 'uid-unreviewed' }],
      { reportUntrackedCandidates: true }
    )[0]).toMatchObject({
      action: 'review-required',
      uid: 'uid-unreviewed'
    });
  });

  it('validates an explicitly reviewed UID against the workspace snapshot', () => {
    const accepted = planDurableEnvironmentsLive(
      planInput({ explicitUids: { dev: 'uid-dev' } }),
      [{ name: 'Payments API - dev', uid: 'uid-dev' }]
    );
    expect(accepted[0]).toMatchObject({ action: 'reuse', uid: 'uid-dev' });

    expect(() => planDurableEnvironmentsLive(
      planInput({ explicitUids: { dev: 'uid-wrong' } }),
      [{ name: 'Payments API - dev', uid: 'uid-dev' }]
    )).toThrow(/UID uid-wrong does not match workspace exact name/);
  });

  it('fails closed on duplicate candidates, conflicting bindings, and unsupported rename', () => {
    expect(() => planDurableEnvironmentsLive(
      planInput(),
      [
        { name: 'Payments API - dev', uid: 'uid-one' },
        { name: 'Payments API - dev', uid: 'uid-two' }
      ]
    )).toThrow(/multiple exact-name candidates/);

    expect(() => planDurableEnvironmentsLive(
      planInput({
        explicitUids: { dev: 'uid-explicit' },
        trackedBindings: {
          dev: { uid: 'uid-tracked', displayName: 'Payments API - dev' }
        }
      }),
      [{ name: 'Payments API - dev', uid: 'uid-tracked' }]
    )).toThrow(/conflicting explicit and tracked UIDs/);

    expect(() => planDurableEnvironmentsOffline(planInput({
      projectName: 'Renamed API',
      trackedBindings: {
        dev: { uid: 'uid-dev', displayName: 'Payments API - dev' }
      }
    }))).toThrow(/would rename.*rename is not supported/);
  });

  it('rejects one live UID appearing under conflicting names', () => {
    expect(() => planDurableEnvironmentsLive(
      planInput({ explicitUids: { dev: 'uid-shared' } }),
      [
        { name: 'Payments API - dev', uid: 'uid-shared' },
        { name: 'Another API - prod', uid: 'uid-shared' }
      ]
    )).toThrow(/UID uid-shared appears under multiple names/);
  });

  it.each([
    ['missing', [{ name: 'Payments API - dev' }]],
    ['empty', [{ name: 'Payments API - dev', uid: '' }]],
    ['whitespace-only', [{ name: 'Payments API - dev', uid: '   ' }]]
  ])('rejects a live environment row with a %s UID', (_label, live) => {
    expect(() => planDurableEnvironmentsLive(
      planInput(),
      live as Array<{ name: string; uid: string }>
    )).toThrow(/environment list contains an entry without a UID/);
  });

  it.each([
    ['missing', { uid: 'uid-dev' }],
    ['non-string', { name: 123, uid: 'uid-dev' }],
    ['empty', { name: '', uid: 'uid-dev' }],
    ['whitespace-only', { name: '   ', uid: 'uid-dev' }]
  ])('rejects a live environment row with a %s name', (_label, row) => {
    expect(() => planDurableEnvironmentsLive(
      planInput(),
      [row] as unknown as Array<{ name: string; uid: string }>
    )).toThrow(/environment list contains an entry without a valid name/);
  });
});

describe('durable environment executor', () => {
  it('fails pre-write drift with zero environment writes', async () => {
    const input = planInput();
    const plan = planDurableEnvironmentsLive(input, []);
    const client = createClient({
      listEnvironments: vi.fn().mockResolvedValue([
        { name: 'Payments API - dev', uid: 'uid-raced' }
      ])
    });

    await expect(applyDurableEnvironmentPlan(input, client, [], plan))
      .rejects.toThrow(/workspace observations changed before mutation/);

    expect(client.createEnvironment).not.toHaveBeenCalled();
    expect(client.updateEnvironment).not.toHaveBeenCalled();
    expect(client.getEnvironment).not.toHaveBeenCalled();
  });

  it('preserves create-only values without PUT or value comparison', async () => {
    const live = [{ name: 'Payments API - dev', uid: 'uid-dev' }];
    const input = planInput({ explicitUids: { dev: 'uid-dev' } });
    const plan = planDurableEnvironmentsLive(input, live);
    const client = createClient({
      listEnvironments: vi.fn().mockResolvedValue(live),
      getEnvironment: vi.fn().mockResolvedValue({
        values: [{ key: 'customerValue', value: 'preserved', type: 'default' }]
      })
    });

    await expect(applyDurableEnvironmentPlan(input, client, live, plan)).resolves.toEqual([
      expect.objectContaining({
        slug: 'dev',
        displayName: 'Payments API - dev',
        action: 'reused-preserved',
        uid: 'uid-dev',
        runtimeSlotKeys: ['jwtToken'],
        observedDigest: expect.stringMatching(/^env-observed-v1:sha256:[0-9a-f]{64}$/)
      })
    ]);

    expect(client.createEnvironment).not.toHaveBeenCalled();
    expect(client.updateEnvironment).not.toHaveBeenCalled();
    expect(client.getEnvironment).toHaveBeenCalledOnce();
  });

  it('creates with fail-on-existing semantics and verifies the live values', async () => {
    const input = planInput();
    const plan = planDurableEnvironmentsLive(input, []);
    const dev = definition('dev');
    const client = createClient({
      listEnvironments: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ name: 'Payments API - dev', uid: 'uid-created' }]),
      createEnvironment: vi.fn().mockResolvedValue('uid-created'),
      getEnvironment: vi.fn().mockResolvedValue(environmentBody(dev))
    });

    await expect(applyDurableEnvironmentPlan(input, client, [], plan)).resolves.toEqual([
      expect.objectContaining({ action: 'create', uid: 'uid-created' })
    ]);
    expect(client.createEnvironment).toHaveBeenCalledWith(
      'ws-123',
      'Payments API - dev',
      dev.values,
      { onExisting: 'error' }
    );
    expect(client.updateEnvironment).not.toHaveBeenCalled();
    expect(client.getEnvironment).toHaveBeenCalledWith('uid-created');
  });

  it('refreshes only a validated UID and verifies replacement values', async () => {
    const live = [{ name: 'Payments API - dev', uid: 'uid-dev' }];
    const input = planInput({ policy: 'refresh', explicitUids: { dev: 'uid-dev' } });
    const plan = planDurableEnvironmentsLive(input, live);
    const dev = definition('dev');
    const client = createClient({
      listEnvironments: vi.fn().mockResolvedValue(live),
      getEnvironment: vi.fn().mockResolvedValue(environmentBody(dev))
    });

    await expect(applyDurableEnvironmentPlan(input, client, live, plan)).resolves.toEqual([
      expect.objectContaining({ action: 'replace', uid: 'uid-dev' })
    ]);
    expect(client.updateEnvironment).toHaveBeenCalledWith(
      'uid-dev',
      'Payments API - dev',
      dev.values
    );
    expect(client.createEnvironment).not.toHaveBeenCalled();
  });

  it('rechecks branch ownership immediately before each replacement', async () => {
    const dev = definition('dev');
    const qa = definition('qa');
    const live = [
      { name: 'Payments API - dev', uid: 'uid-dev' },
      { name: 'Payments API - qa', uid: 'uid-qa' }
    ];
    const input = planInput({
      policy: 'refresh',
      environments: ['dev', 'qa'],
      definitions: definitionsFor(dev, qa),
      explicitUids: { dev: 'uid-dev', qa: 'uid-qa' }
    });
    const plan = planDurableEnvironmentsLive(input, live);
    const client = createClient({
      listEnvironments: vi.fn().mockResolvedValue(live),
      getEnvironment: vi.fn()
        .mockResolvedValueOnce(environmentBody(dev))
        .mockResolvedValueOnce(environmentBody(dev))
        .mockResolvedValueOnce({
          values: [{ key: 'x-pm-onboarding', value: '{}', type: 'default' }]
        })
    });

    await expect(applyDurableEnvironmentPlan(input, client, live, plan))
      .rejects.toMatchObject({
        failedSlug: 'qa',
        completedEntries: [expect.objectContaining({ slug: 'dev', action: 'replace' })],
        cause: expect.objectContaining({ message: expect.stringMatching(/branch asset lifecycle/) })
      });

    expect(client.updateEnvironment).toHaveBeenCalledOnce();
    expect(client.updateEnvironment).toHaveBeenCalledWith(
      'uid-dev',
      'Payments API - dev',
      dev.values
    );
  });

  it('verifies secret-slot metadata without comparing the live secret value', async () => {
    const live = [{ name: 'Payments API - dev', uid: 'uid-dev' }];
    const input = planInput({ policy: 'refresh', explicitUids: { dev: 'uid-dev' } });
    const plan = planDurableEnvironmentsLive(input, live);
    const dev = definition('dev');
    const client = createClient({
      listEnvironments: vi.fn().mockResolvedValue(live),
      getEnvironment: vi.fn().mockResolvedValue({
        values: dev.values.map((value) =>
          value.type === 'secret' ? { ...value, value: 'runtime-only' } : value
        )
      })
    });

    const result = await applyDurableEnvironmentPlan(input, client, live, plan);
    expect(result[0]).toMatchObject({
      action: 'replace',
      observedDigest: expect.stringMatching(/^env-observed-v1:sha256:/)
    });
    expect(JSON.stringify(result)).not.toContain('runtime-only');
  });

  it.each([
    ['typed secret', { key: 'jwtToken', type: 'secret', enabled: true }],
    ['canonical secret', { key: 'jwtToken', secret: true, enabled: true }]
  ])('accepts a value-less %s response', async (_label, secretValue) => {
    const live = [{ name: 'Payments API - dev', uid: 'uid-dev' }];
    const input = planInput({ explicitUids: { dev: 'uid-dev' } });
    const plan = planDurableEnvironmentsLive(input, live);
    const client = createClient({
      listEnvironments: vi.fn().mockResolvedValue(live),
      getEnvironment: vi.fn().mockResolvedValue({
        values: [
          { key: 'baseUrl', value: 'https://dev.example.com', type: 'default', enabled: true },
          secretValue
        ]
      })
    });

    await expect(applyDurableEnvironmentPlan(input, client, live, plan)).resolves.toEqual([
      expect.objectContaining({ action: 'reused-preserved', uid: 'uid-dev' })
    ]);
  });

  it('fails reuse when the live environment body cannot be read', async () => {
    const live = [{ name: 'Payments API - dev', uid: 'uid-dev' }];
    const input = planInput({ explicitUids: { dev: 'uid-dev' } });
    const plan = planDurableEnvironmentsLive(input, live);
    const client = createClient({
      listEnvironments: vi.fn().mockResolvedValue(live),
      getEnvironment: vi.fn().mockResolvedValue(null)
    });

    await expect(applyDurableEnvironmentPlan(input, client, live, plan))
      .rejects.toMatchObject({
        failedSlug: 'dev',
        cause: expect.objectContaining({ message: expect.stringMatching(/could not be read/) })
      });
    expect(client.createEnvironment).not.toHaveBeenCalled();
    expect(client.updateEnvironment).not.toHaveBeenCalled();
  });

  it.each([
    ['missing values', {}],
    ['non-array values', { values: {} }],
    ['non-object value row', { values: [null] }],
    ['value row without a string key', { values: [{ value: 'partial' }] }],
    ['value row without a value', { values: [{ key: 'baseUrl' }] }],
    ['value row with a non-string value', { values: [{ key: 'baseUrl', value: 42 }] }],
    ['value row with an invalid type', { values: [{ key: 'baseUrl', value: '', type: 'unknown' }] }],
    ['value row with a non-boolean enabled flag', { values: [{ key: 'baseUrl', value: '', enabled: 'yes' }] }]
  ])('fails reuse for a malformed environment body with %s', async (_label, body) => {
    const live = [{ name: 'Payments API - dev', uid: 'uid-dev' }];
    const input = planInput({ explicitUids: { dev: 'uid-dev' } });
    const plan = planDurableEnvironmentsLive(input, live);
    const client = createClient({
      listEnvironments: vi.fn().mockResolvedValue(live),
      getEnvironment: vi.fn().mockResolvedValue(body)
    });

    await expect(applyDurableEnvironmentPlan(input, client, live, plan))
      .rejects.toMatchObject({
        failedSlug: 'dev',
        cause: expect.objectContaining({
          message: expect.stringMatching(/response values/)
        })
      });
    expect(client.createEnvironment).not.toHaveBeenCalled();
    expect(client.updateEnvironment).not.toHaveBeenCalled();
  });

  it('detects a post-refresh UID/name mismatch', async () => {
    const live = [{ name: 'Payments API - dev', uid: 'uid-dev' }];
    const input = planInput({ policy: 'refresh', explicitUids: { dev: 'uid-dev' } });
    const plan = planDurableEnvironmentsLive(input, live);
    const client = createClient({
      listEnvironments: vi.fn()
        .mockResolvedValueOnce(live)
        .mockResolvedValueOnce(live)
        .mockResolvedValueOnce([{ name: 'Renamed elsewhere', uid: 'uid-dev' }])
    });

    await expect(applyDurableEnvironmentPlan(input, client, live, plan))
      .rejects.toMatchObject({
        failedSlug: 'dev',
        completedEntries: [expect.objectContaining({ uid: 'uid-dev', action: 'replace' })],
        cause: expect.objectContaining({ message: expect.stringMatching(/binding changed/) })
      });
    expect(client.updateEnvironment).toHaveBeenCalledOnce();
    expect(client.getEnvironment).toHaveBeenCalledOnce();
  });

  it.each([
    ['create-only' as DurableEnvironmentPolicy, 'create'],
    ['refresh' as DurableEnvironmentPolicy, 'replace']
  ])('fails %s when the post-write values do not converge', async (policy, action) => {
    const live = action === 'replace'
      ? [{ name: 'Payments API - dev', uid: 'uid-dev' }]
      : [];
    const explicitUids: Record<string, string> = action === 'replace'
      ? { dev: 'uid-dev' }
      : {};
    const input = planInput({ policy, explicitUids });
    const plan = planDurableEnvironmentsLive(input, live);
    const createdLive = [{ name: 'Payments API - dev', uid: 'uid-created' }];
    const client = createClient({
      listEnvironments: action === 'create'
        ? vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(createdLive)
        : vi.fn().mockResolvedValue(live),
      getEnvironment: vi.fn().mockResolvedValue({
        values: [{ key: 'baseUrl', value: 'https://wrong.example.com' }]
      })
    });

    let failure: unknown;
    try {
      await applyDurableEnvironmentPlan(input, client, live, plan);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DurableEnvironmentPartialApplyError);
    expect(failure).toMatchObject({
      failedSlug: 'dev',
      completedEntries: [expect.objectContaining({ slug: 'dev', action })]
    });
    expect((failure as Error & { cause?: Error }).cause?.message)
      .toMatch(/did not converge to the requested value metadata/);
  });

  it('leaves an earlier successful create in place when a later create fails', async () => {
    const dev = definition('dev');
    const qa = definition('qa');
    const input = planInput({
      environments: ['dev', 'qa'],
      definitions: definitionsFor(dev, qa)
    });
    const plan = planDurableEnvironmentsLive(input, []);
    const client = createClient({
      listEnvironments: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ name: 'Payments API - dev', uid: 'uid-dev' }])
        .mockResolvedValueOnce([{ name: 'Payments API - dev', uid: 'uid-dev' }]),
      createEnvironment: vi.fn()
        .mockResolvedValueOnce('uid-dev')
        .mockRejectedValueOnce(new Error('qa create failed')),
      getEnvironment: vi.fn().mockResolvedValue(environmentBody(dev))
    });

    let failure: unknown;
    try {
      await applyDurableEnvironmentPlan(input, client, [], plan);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DurableEnvironmentPartialApplyError);
    expect(failure).toMatchObject({
      code: 'DURABLE_ENVIRONMENT_PARTIAL_APPLY_FAILED',
      failedSlug: 'qa',
      completedEntries: [
        expect.objectContaining({ slug: 'dev', uid: 'uid-dev', action: 'create' })
      ]
    });
    expect((failure as Error).message).not.toContain('qa create failed');

    expect(client.createEnvironment).toHaveBeenCalledTimes(2);
    expect(client.getEnvironment).toHaveBeenCalledExactlyOnceWith('uid-dev');
    expect(client.updateEnvironment).not.toHaveBeenCalled();
  });

  it('rechecks each entry and stops when a later exact name appears', async () => {
    const dev = definition('dev');
    const qa = definition('qa');
    const input = planInput({
      environments: ['dev', 'qa'],
      definitions: definitionsFor(dev, qa)
    });
    const plan = planDurableEnvironmentsLive(input, []);
    const devLive = { name: 'Payments API - dev', uid: 'uid-dev' };
    const client = createClient({
      listEnvironments: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([devLive])
        .mockResolvedValueOnce([
          devLive,
          { name: 'Payments API - qa', uid: 'uid-raced' }
        ]),
      createEnvironment: vi.fn().mockResolvedValue('uid-dev'),
      getEnvironment: vi.fn().mockResolvedValue(environmentBody(dev))
    });

    await expect(applyDurableEnvironmentPlan(input, client, [], plan))
      .rejects.toMatchObject({
        failedSlug: 'qa',
        completedEntries: [expect.objectContaining({ uid: 'uid-dev' })],
        cause: expect.objectContaining({ message: expect.stringMatching(/appeared before create/) })
      });
    expect(client.createEnvironment).toHaveBeenCalledOnce();
  });
});
