export type ActionInputDefinition = {
  description: string;
  required: boolean;
  default?: string;
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
    'Public open-alpha contract for syncing exported Postman assets into a repository and keeping workspace-link concerns separate from provisioning.',
  defaults: {
    integrationBackend: 'bifrost',
    artifactDir: 'postman',
    repoWriteMode: 'commit-and-push',
    workspaceLinkEnabled: true,
    environmentSyncEnabled: true,
    committerName: 'Postman CSE',
    committerEmail: 'help@postman.com'
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
    'monitor-id': {
      description: 'Existing smoke monitor ID. When set, the action validates and reuses this monitor instead of creating a new one.',
      required: false
    },
    'mock-url': {
      description: 'Existing mock server URL. When set, the action validates and reuses this mock instead of creating a new one.',
      required: false
    },
    'monitor-cron': {
      description: "Cron expression for monitor scheduling (e.g. '0 */6 * * *'). When empty, the monitor is created in a disabled state.",
      required: false,
      default: ''
    },
    'environments-json': {
      description: 'JSON array of environment slugs to create or update.',
      required: false,
      default: '["prod"]'
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
      default: 'Postman CSE'
    },
    'committer-email': {
      description: 'Git committer email for sync commits.',
      required: false,
      default: 'help@postman.com'
    },
    'postman-api-key': {
      description: 'Postman API key used for environment, mock, and monitor operations.',
      required: false
    },
    'postman-access-token': {
      description: 'Postman access token used for Bifrost and system environment association.',
      required: false
    },
    'github-token': {
      description: 'GitHub token used for repo variable persistence and commits.',
      required: false
    },
    'gh-fallback-token': {
      description: 'Fallback token for repository variable APIs and workflow-file pushes.',
      required: false
    },
    'github-auth-mode': {
      description: 'GitHub auth mode for repository variable APIs.',
      required: false,
      default: 'github_token_first'
    },
    'org-mode': {
      description: 'Whether the Postman team uses org-mode. When true, x-entity-team-id header is included in Bifrost proxy calls. Non-org teams must omit this header.',
      required: false,
      default: 'false'
    },
    'ci-workflow-base64': {
      description: 'Optional base64-encoded ci.yml content. Defaults to the built-in template.',
      required: false
    }
  },
  outputs: {
    'integration-backend': {
      description: 'Resolved integration backend for the open-alpha run.'
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
    }
  },
  behavior: {
    retainedFromFinalize: [
      'Create or update Postman environments from runtime URLs.',
      'Associate Postman environments to system environments through Bifrost.',
      'Create mock servers and smoke monitors from generated collections.',
      'Export Postman collections in the Collection v3 multi-file YAML directory structure under `postman/collections/` (e.g., `[Baseline] <name>/collection.yaml`, nested folder and request YAML files). Persist repo variables and export environments into the repository under `postman/` and `.postman/`.',
      'Link the Postman workspace to the repository (GitHub or GitLab) through Bifrost.',
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
