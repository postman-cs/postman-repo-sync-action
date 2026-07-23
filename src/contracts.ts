export type ActionInputDefinition = {
  description: string;
  required: boolean;
  default?: string;
  allowedValues?: string[];
};

export type ActionOutputDefinition = {
  description: string;
};

export type ExecutionPlan = {
  integrationBackend: string;
  resolvedCurrentRef: string;
  workspaceLinkStatus: 'planned' | 'skipped';
  environmentSyncStatus: 'planned' | 'skipped';
  repoWriteMode: string;
  outputs: Record<string, string>;
};

export type ExecutionPlanOptions = {
  integrationBackend?: string;
  workspaceLinkEnabled?: boolean;
  environmentSyncEnabled?: boolean;
  repoWriteMode?: string;
  currentRef?: string;
  githubHeadRef?: string;
  githubRefName?: string;
};

export const postmanRepoSyncActionContract: {
  name: string;
  description: string;
  defaults: {
    integrationBackend: string;
    artifactDir: string;
    repoWriteMode: string;
    collectionSyncMode: string;
    specSyncMode: string;
    workspaceLinkEnabled: boolean;
    environmentSyncEnabled: boolean;
    committerName: string;
    committerEmail: string;
  };
  inputs: Record<string, ActionInputDefinition>;
  outputs: Record<string, ActionOutputDefinition>;
  behavior: {
    retainedFromFinalize: string[];
    removedFromFinalize: string[];
  };
} = {
  name: 'postman-repo-sync-action',
  description:
    'Contract for syncing exported Postman assets into a repository and keeping workspace-link concerns separate from provisioning.',
  defaults: {
    integrationBackend: 'bifrost',
    artifactDir: 'postman',
    repoWriteMode: 'commit-and-push',
    collectionSyncMode: 'refresh',
    specSyncMode: 'update',
    workspaceLinkEnabled: true,
    environmentSyncEnabled: true,
    committerName: 'Postman',
    committerEmail: 'support@postman.com'
  },
  inputs: {

    'generate-ci-workflow': {
      description: 'Whether to generate the CI workflow file',
      required: false,
      default: 'true'
    },
    'ci-workflow-path': {
      description: 'Path to write the generated CI workflow file',
      required: false,
      default: '.github/workflows/ci.yml'
    },
    'ci-runner-os': {
      description: 'Runner operating system for the generated CI workflow.',
      required: false,
      default: 'linux',
      allowedValues: ['linux', 'windows']
    },
    'project-name': {
      description: 'Service project name used for environment, mock, and monitor naming.',
      required: true
    },
    'workspace-id': {
      description: 'Postman workspace ID used for workspace-link and export metadata.',
      required: false
    },
    'baseline-collection-id': {
      description: 'Baseline collection ID used for exported artifacts and mock server creation.',
      required: false
    },
    'monitor-type': {
      description: 'Type of monitor to create ("cloud" or "cli"). "cli" will skip cloud monitor creation and rely on the CI workflow.',
      required: false,
      default: 'cloud'
    },
    'smoke-collection-id': {
      description: 'Smoke collection ID used for monitor creation.',
      required: false
    },
    'contract-collection-id': {
      description: 'Contract collection ID used for exported artifacts.',
      required: false
    },
    'prebuilt-collections-json': {
      description:
        'Optional digest-bound JSON manifest of locally materialized Collection v3 trees (schemaVersion 1 or a bare entry array). Exact path/cloudId/tree/artifactDigest matches reuse the on-disk tree without cloud export.',
      required: false,
      default: ''
    },
    'collection-sync-mode': {
      description: 'Collection sync lifecycle mode (refresh or version).',
      required: false,
      default: 'refresh'
    },
    'spec-sync-mode': {
      description: 'Spec sync lifecycle mode (update or version).',
      required: false,
      default: 'update'
    },
    'release-label': {
      description: 'Optional release label used for versioned naming.',
      required: false
    },
    'monitor-id': {
      description: 'Existing smoke monitor ID. When set, the action validates and reuses this monitor instead of creating a new one.',
      required: false
    },
    'mock-url': {
      description: 'Existing mock server URL. When set, the action validates and reuses this mock instead of creating a new one.',
      required: false
    },
    'monitor-cron': {
      description: "Cron expression for monitor scheduling (e.g. '0 */6 * * *'). When empty, the monitor is created disabled and triggered to run once per workflow invocation (and once on every subsequent run).",
      required: false,
      default: ''
    },
    'environments-json': {
      description: 'JSON array of environment slugs to create or update.',
      required: false,
      default: '["prod"]'
    },
    'git-provider': {
      description: "Git provider override ('github', 'gitlab', 'bitbucket', 'azure-devops'). Auto-detected when omitted.",
      required: false,
      allowedValues: ['github', 'gitlab', 'bitbucket', 'azure-devops']
    },
    'ado-token': {
      description: 'Azure DevOps personal access token or system token used to push commits in Azure Pipelines. Defaults to SYSTEM_ACCESSTOKEN when available.',
      required: false
    },
    'repo-url': {
      description: 'Explicit repository URL. Defaults to the workflow repository URL.',
      required: false
    },
    'integration-backend': {
      description: 'Integration backend for workspace linking and environment sync.',
      required: false,
      default: 'bifrost'
    },
    'workspace-link-enabled': {
      description: 'Enable workspace linking.',
      required: false,
      default: 'true'
    },
    'environment-sync-enabled': {
      description: 'Enable system environment association.',
      required: false,
      default: 'true'
    },
    'system-env-map-json': {
      description: 'JSON map of environment slug to system environment id.',
      required: false,
      default: '{}'
    },
    'environment-uids-json': {
      description: 'JSON map of environment slug to Postman environment uid.',
      required: false,
      default: '{}'
    },
    'env-runtime-urls-json': {
      description: 'JSON map of environment slug to runtime base URL.',
      required: false,
      default: '{}'
    },
    'artifact-dir': {
      description: 'Root directory for exported Postman artifacts.',
      required: false,
      default: 'postman'
    },
    'repo-write-mode': {
      description: 'Repo mutation mode for generated artifacts and workflow files.',
      required: false,
      default: 'commit-and-push'
    },
    'current-ref': {
      description: 'Explicit ref override for push-changes when checkout is detached.',
      required: false
    },
    'committer-name': {
      description: 'Git committer name for sync commits.',
      required: false,
      default: 'Postman'
    },
    'committer-email': {
      description: 'Git committer email for sync commits.',
      required: false,
      default: 'support@postman.com'
    },
    'postman-api-key': {
      description: 'Postman API key used for environment, mock, and monitor operations.',
      required: false
    },
    'postman-access-token': {
      description:
        'Postman access token used for workspace linking, system environment association, and generated API-key creation.',
      required: false
    },
    'team-id': {
      description:
        'Postman team ID resolved by postman-resolve-service-token-action for org-mode integration calls. Falls back to POSTMAN_TEAM_ID when omitted.',
      required: false,
      default: ''
    },
    'credential-preflight': {
      description:
        'Credential identity preflight policy. warn (default) logs a note and continues when postman-api-key and postman-access-token resolve to different parent orgs; enforce fails the run on that condition before any workspace is created. Both modes warn when postman-access-token is not a service-account token.',
      required: false,
      default: 'warn',
      allowedValues: ['enforce', 'warn']
    },
    'branch-strategy': {
      description:
        'Branch-aware sync strategy. legacy (default) keeps branch-blind behavior; publish-gate restricts canonical writes to the canonical branch and skips repo-sync on other branches; preview additionally maintains suffixed per-branch preview asset sets.',
      required: false,
      default: 'legacy',
      allowedValues: ['legacy', 'preview', 'publish-gate']
    },
    'canonical-branch': {
      description:
        'Explicit canonical branch (the sole writer of canonical assets and tracked state). Defaults to the provider-resolved default branch; required on providers without a default-branch variable (Bitbucket, Azure DevOps) when branch-strategy is not legacy.',
      required: false
    },
    'channels': {
      description:
        'Comma-separated channel map for long-lived promotion branches, e.g. "develop=DEV, staging=STAGE, release/*=RC". Channel branches maintain prefix-named parallel asset sets and never mutate canonical assets.',
      required: false
    },
    'preview-ttl': {
      description:
        'Sliding TTL in days for preview asset sets (refreshed on every successful preview sync; the retention contract of last resort when no provider credential is available for branch-existence checks).',
      required: false,
      default: '30'
    },
    'github-token': {
      description: 'GitHub token used for repo variable persistence and commits.',
      required: false
    },
    'gh-fallback-token': {
      description: 'Fallback token for repository variable APIs and workflow-file pushes.',
      required: false
    },
    'org-mode': {
      description: 'Whether the Postman team uses org-mode. When true, x-entity-team-id is included in Postman integration API calls. Non-org teams must omit this header.',
      required: false,
      default: 'false'
    },
    'ci-workflow-base64': {
      description: 'Optional base64-encoded ci.yml content. Defaults to the built-in template.',
      required: false
    },
    'ssl-client-cert': {
      description: 'Base64-encoded PEM client certificate for Postman CLI mTLS runs.',
      required: false
    },
    'ssl-client-key': {
      description: 'Base64-encoded PEM client private key for Postman CLI mTLS runs.',
      required: false
    },
    'ssl-client-passphrase': {
      description: 'Optional passphrase for encrypted ssl-client-key.',
      required: false
    },
    'ssl-extra-ca-certs': {
      description: 'Optional base64-encoded PEM CA certificate bundle for custom trust.',
      required: false
    },
    'spec-id': {
      description: 'Spec UID from bootstrap, persisted into .postman/resources.yaml cloudResources.',
      required: false
    },
    'spec-content-changed': {
      description: 'Whether bootstrap changed canonical spec content; controls final native Spec Hub tag publication.',
      required: false,
      default: 'true'
    },
    'spec-path': {
      description: 'Optional repo-root-relative path to the local spec file for resources/workflows metadata.',
      required: false
    },
    'postman-region': {
      description: 'Postman data residency region for public API and Postman CLI calls. One of: us or eu.',
      required: false,
      default: 'us',
      allowedValues: ['us', 'eu']
    },
    'postman-stack': {
      description: 'Postman stack profile. Leave at the default unless Postman support directs otherwise.',
      required: false,
      default: 'prod',
      allowedValues: ['prod', 'beta']
    }
  },
  outputs: {
    'integration-backend': {
      description: 'Resolved integration backend for the onboarding run.'
    },
    'resolved-current-ref': {
      description: 'Resolved push target based on current-ref semantics.'
    },
    'workspace-link-status': {
      description: 'Whether workspace linking succeeded, was skipped, or failed.'
    },
    'environment-sync-status': {
      description: 'Whether environment sync succeeded, was skipped, or failed.'
    },
    'environment-uids-json': {
      description: 'JSON map of environment slug to Postman environment uid.'
    },
    'mock-url': {
      description: 'Created or reused mock server URL.'
    },
    'monitor-id': {
      description: 'Created or reused smoke monitor ID.'
    },
    'repo-sync-summary-json': {
      description: 'JSON summary of repo materialization and workspace sync outputs.'
    },
    'commit-sha': {
      description: 'Commit SHA produced by repo-write-mode, if any.'
    },
    'sync-status': {
      description: 'Branch-aware sync status: synced, skipped-branch-gate, or empty under branch-strategy legacy.'
    },
    'branch-decision': {
      description: 'Serialized BranchDecision JSON for downstream actions (also exported as POSTMAN_BRANCH_DECISION).'
    },
    'spec-version-tag': {
      description: 'Native Spec Hub version tag created after successful canonical repo-sync finalization.'
    },
    'spec-version-url': {
      description: 'Read-only URL for the tagged Spec Hub snapshot.'
    }
  },
  behavior: {
    retainedFromFinalize: [
      'Create or update Postman environments from runtime URLs.',
      'Associate Postman environments to system environments through Postman integration APIs.',
      'Create mock servers and smoke monitors from generated collections.',
      'Export Postman collections in the Collection v3 multi-file YAML directory structure under `postman/collections/` (canonical `.resources/definition.yaml` plus request/resource YAML files), and export environments plus `.postman/resources.yaml` into the repository.',
      'Link the Postman workspace to the repository (GitHub or GitLab) through Postman integration APIs.',
      'Commit synced artifacts and push them back to the current checked out ref.'
    ],
    removedFromFinalize: [
      'Generate Fern docs or write documentation URLs back to GitHub.',
      'Store AWS deployment orchestration concerns in the public action interface.',
      'Push directly to `main`.'
    ]
  }
};

export function resolveCurrentRef(options: ExecutionPlanOptions): string {
  if (String(options.repoWriteMode ?? '').trim() !== 'commit-and-push') {
    return '';
  }

  const candidates = [
    options.currentRef,
    options.githubHeadRef,
    options.githubRefName
  ];

  for (const candidate of candidates) {
    const trimmed = String(candidate ?? '').trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return '';
}

export function createExecutionPlan(
  options: ExecutionPlanOptions = {}
): ExecutionPlan {
  const integrationBackend =
    String(options.integrationBackend ?? '').trim() ||
    postmanRepoSyncActionContract.defaults.integrationBackend;

  return {
    integrationBackend,
    resolvedCurrentRef: resolveCurrentRef(options),
    repoWriteMode:
      String(options.repoWriteMode ?? '').trim() ||
      postmanRepoSyncActionContract.defaults.repoWriteMode,
    workspaceLinkStatus:
      options.workspaceLinkEnabled ??
      postmanRepoSyncActionContract.defaults.workspaceLinkEnabled
        ? 'planned'
        : 'skipped',
    environmentSyncStatus:
      options.environmentSyncEnabled ??
      postmanRepoSyncActionContract.defaults.environmentSyncEnabled
        ? 'planned'
        : 'skipped',
    outputs: {
      'environment-uids-json': '{}',
      'mock-url': '',
      'monitor-id': '',
      'repo-sync-summary-json': JSON.stringify({
        artifactDir: postmanRepoSyncActionContract.defaults.artifactDir,
        repoWriteMode:
          String(options.repoWriteMode ?? '').trim() ||
          postmanRepoSyncActionContract.defaults.repoWriteMode
      }),
      'commit-sha': ''
    }
  };
}
