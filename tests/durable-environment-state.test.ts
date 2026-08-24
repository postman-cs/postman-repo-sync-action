import { describe, expect, it } from 'vitest';

import {
  assertCanonicalEnvironmentReferences,
  DURABLE_ENVIRONMENT_RESOURCES_STATE_VERSION,
  parseDurableEnvironmentProvisioningState,
  upsertDurableEnvironmentProvisioningState
} from '../src/lib/postman/durable-environment-state.js';
import {
  StateUnreadableError,
  type PostmanResourcesState
} from '../src/lib/postman/environment-reconciliation.js';

const ARTIFACT = '../postman/environments/Payments API - dev.environment.yaml';
const UID = '123-env-dev';
const DIGEST = `env-definition-v1:sha256:${'a'.repeat(64)}`;

function stateV2(
  overrides: Partial<PostmanResourcesState> = {}
): PostmanResourcesState {
  return {
    version: 2,
    workspace: { id: 'ws-123' },
    canonical: {
      environments: { [ARTIFACT]: UID }
    },
    ...overrides
  };
}

function upsertInput(overrides: Partial<Parameters<
  typeof upsertDurableEnvironmentProvisioningState
>[1]> = {}): Parameters<typeof upsertDurableEnvironmentProvisioningState>[1] {
  return {
    projectKey: 'payments',
    slug: 'dev',
    uid: UID,
    artifact: ARTIFACT,
    displayName: 'Payments API - dev',
    policy: 'create-only',
    definitionDigest: DIGEST,
    ...overrides
  };
}

describe('durable environment resources state v3', () => {
  it('keeps v2 canonical environment mappings unclassified without durable metadata', () => {
    const state = stateV2();

    expect(parseDurableEnvironmentProvisioningState(state)).toEqual([]);
    expect(state.version).toBe(2);
    expect(state).not.toHaveProperty('environmentProvisioning');
  });

  it('rejects a noncanonical v2 environment ref before it can become durable authority', () => {
    const state = stateV2({
      canonical: {
        environments: {
          '../postman/environments/./Payments API - dev.environment.yaml': UID
        }
      }
    });

    expect(() => assertCanonicalEnvironmentReferences(state))
      .toThrow(/canonical repository-relative manifest reference/);
  });

  it('keeps canonical legacy JSON environment refs valid during migration', () => {
    const state = stateV2({
      canonical: {
        environments: {
          '../postman/environments/dev.postman_environment.json': UID
        }
      }
    });

    expect(() => assertCanonicalEnvironmentReferences(state)).not.toThrow();
  });

  it('upgrades a reviewed v2 binding to v3 while canonical environments remain sole UID authority', () => {
    const prior = stateV2();
    const next = upsertDurableEnvironmentProvisioningState(prior, upsertInput());

    expect(next.version).toBe(DURABLE_ENVIRONMENT_RESOURCES_STATE_VERSION);
    expect(next.canonical).toEqual(prior.canonical);
    expect(next.environmentProvisioning?.projects?.payments?.environments?.dev)
      .toEqual({
        artifact: ARTIFACT,
        displayName: 'Payments API - dev',
        policy: 'create-only',
        definitionDigest: DIGEST
      });
    expect(next.environmentProvisioning?.projects?.payments?.environments?.dev)
      .not.toHaveProperty('uid');
    expect(parseDurableEnvironmentProvisioningState(next)).toEqual([{
      projectKey: 'payments',
      slug: 'dev',
      uid: UID,
      artifact: ARTIFACT,
      displayName: 'Payments API - dev',
      policy: 'create-only',
      definitionDigest: DIGEST
    }]);
    expect(prior.version).toBe(2);
    expect(prior).not.toHaveProperty('environmentProvisioning');
  });

  it('preserves unknown fields at every state and metadata level', () => {
    const prior = stateV2({
      vendorRoot: { keep: true },
      environmentProvisioning: {
        vendorProvisioning: 'keep',
        projects: {
          payments: {
            vendorProject: 7,
            environments: {
              dev: {
                artifact: ARTIFACT,
                displayName: 'Payments API - dev',
                policy: 'create-only',
                definitionDigest: DIGEST,
                vendorEntry: ['keep']
              }
            }
          },
          unrelated: {
            environments: {}
          }
        }
      }
    });
    prior.version = 3;

    const next = upsertDurableEnvironmentProvisioningState(
      prior,
      upsertInput({ policy: 'refresh' })
    );

    expect(next.vendorRoot).toEqual({ keep: true });
    expect(next.environmentProvisioning?.vendorProvisioning).toBe('keep');
    expect(next.environmentProvisioning?.projects?.payments?.vendorProject).toBe(7);
    expect(next.environmentProvisioning?.projects?.payments?.environments?.dev?.vendorEntry)
      .toEqual(['keep']);
    expect(next.environmentProvisioning?.projects?.payments?.environments?.dev?.policy)
      .toBe('refresh');
    expect(next.environmentProvisioning?.projects?.unrelated).toEqual({ environments: {} });
  });

  it('stores prototype-sensitive project keys and slugs in null-prototype maps', () => {
    const artifact = '../postman/environments/Payments API - __proto__.environment.yaml';
    const next = upsertDurableEnvironmentProvisioningState(
      stateV2({ canonical: { environments: { [artifact]: UID } } }),
      upsertInput({
        projectKey: 'constructor',
        slug: '__proto__',
        artifact,
        displayName: 'Payments API - __proto__'
      })
    );
    const projects = next.environmentProvisioning?.projects;

    expect(Object.getPrototypeOf(projects)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(projects, 'constructor')).toBe(true);
    const environments = projects?.['constructor']?.environments;
    expect(Object.getPrototypeOf(environments)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(environments, '__proto__')).toBe(true);
    expect(parseDurableEnvironmentProvisioningState(next)).toContainEqual({
      projectKey: 'constructor',
      slug: '__proto__',
      uid: UID,
      artifact,
      displayName: 'Payments API - __proto__',
      policy: 'create-only',
      definitionDigest: DIGEST
    });
  });

  it('resolves durable UIDs only from canonical.environments', () => {
    const state = upsertDurableEnvironmentProvisioningState(stateV2({
      cloudResources: {
        environments: { [ARTIFACT]: 'transient-conflict' }
      }
    }), upsertInput());

    expect(parseDurableEnvironmentProvisioningState(state)[0]?.uid).toBe(UID);
  });

  it('rejects metadata on state v2 instead of implicitly changing its meaning', () => {
    const state = stateV2({
      environmentProvisioning: {
        projects: {
          payments: {
            environments: {
              dev: {
                artifact: ARTIFACT,
                displayName: 'Payments API - dev',
                policy: 'create-only',
                definitionDigest: DIGEST
              }
            }
          }
        }
      }
    });

    expect(() => parseDurableEnvironmentProvisioningState(state))
      .toThrow(/requires resources state version 3/);
  });

  it('rejects present non-mapping durable metadata instead of treating it as absent', () => {
    const state = stateV2();
    state.version = 3;
    state.environmentProvisioning = null as never;

    expect(() => parseDurableEnvironmentProvisioningState(state))
      .toThrow(/environmentProvisioning must be a mapping/);
  });

  it('rejects a durable metadata artifact missing from canonical environments', () => {
    const state = upsertDurableEnvironmentProvisioningState(stateV2(), upsertInput());
    state.canonical = { environments: {} };

    expect(() => parseDurableEnvironmentProvisioningState(state))
      .toThrow(/does not resolve through canonical\.environments/);
  });

  it('rejects canonical references that collapse to the same durable artifact', () => {
    const state = upsertDurableEnvironmentProvisioningState(stateV2(), upsertInput());
    state.canonical = {
      environments: {
        [ARTIFACT]: UID,
        '../postman/environments/../environments/Payments API - dev.environment.yaml': UID
      }
    };

    expect(() => parseDurableEnvironmentProvisioningState(state))
      .toThrow(/canonical repository-relative manifest reference/);
  });

  it('rejects metadata that duplicates UID authority', () => {
    const state = upsertDurableEnvironmentProvisioningState(stateV2(), upsertInput());
    const entry = state.environmentProvisioning?.projects?.payments?.environments?.dev;
    if (!entry) throw new Error('test setup failed');
    entry.uid = UID;

    expect(() => parseDurableEnvironmentProvisioningState(state))
      .toThrow(/duplicates canonical\.environments UID authority/);
  });

  it('rejects two durable identities claiming the same canonical UID', () => {
    const state = upsertDurableEnvironmentProvisioningState(stateV2(), upsertInput());
    const projects = state.environmentProvisioning?.projects;
    if (!projects) throw new Error('test setup failed');
    projects.orders = {
      environments: {
        qa: {
          artifact: ARTIFACT,
          displayName: 'Orders API - qa',
          policy: 'refresh',
          definitionDigest: DIGEST
        }
      }
    };

    expect(() => parseDurableEnvironmentProvisioningState(state))
      .toThrow(/claim artifact/);
  });

  it.each([
    ['policy', { policy: 'merge' }, /must be "create-only" or "refresh"/],
    ['digest', { definitionDigest: 'sha256:ABC' }, /env-definition-v1/],
    ['artifact', { artifact: '../../outside.environment.yaml' }, /canonical environment YAML artifact|outside the repository/],
    ['display name', { displayName: ' ' }, /non-empty string/]
  ])('rejects an invalid %s during serialization', (_label, override, expected) => {
    expect(() => upsertDurableEnvironmentProvisioningState(
      stateV2(),
      upsertInput(override as Partial<Parameters<
        typeof upsertDurableEnvironmentProvisioningState
      >[1]>)
    )).toThrow(expected);
  });

  it('rejects an upsert UID that disagrees with canonical environments', () => {
    expect(() => upsertDurableEnvironmentProvisioningState(
      stateV2(),
      upsertInput({ uid: 'wrong-uid' })
    )).toThrow(/expected UID wrong-uid.*resolves 123-env-dev/);
  });

  it('uses the state contract error code for every corruption failure', () => {
    try {
      upsertDurableEnvironmentProvisioningState(
        stateV2(),
        upsertInput({ uid: 'wrong-uid' })
      );
      throw new Error('expected state validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(StateUnreadableError);
      expect((error as StateUnreadableError).code).toBe('CONTRACT_STATE_UNREADABLE');
    }
  });
});
