import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleReporter, parseCliArgs, toDotenv } from '../src/cli.js';
import { resolveInputs } from '../src/index.js';

describe('cli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps flags to INPUT_* env variables', () => {
    const config = parseCliArgs(
      [
        '--project-name',
        'core-payments',
        '--workspace-id=ws-123',
        '--repo-url',
        'https://github.com/postman-cs/repo-sync-demo',
        '--team-id',
        'team-001',
        '--result-json',
        'outputs/result.json',
        '--dotenv-path=.env.repo-sync'
      ],
      { EXISTING_ENV: 'keep-me' }
    );

    expect(config.inputEnv.EXISTING_ENV).toBe('keep-me');
    expect(config.inputEnv.INPUT_PROJECT_NAME).toBe('core-payments');
    expect(config.inputEnv.INPUT_WORKSPACE_ID).toBe('ws-123');
    expect(config.inputEnv.INPUT_REPO_URL).toBe('https://github.com/postman-cs/repo-sync-demo');
    expect(config.inputEnv.INPUT_TEAM_ID).toBe('team-001');
    expect(config.resultJsonPath).toBe('outputs/result.json');
    expect(config.dotenvPath).toBe('.env.repo-sync');
  });

  it('formats dotenv output with POSTMAN_REPO_SYNC_ prefix', () => {
    const rendered = toDotenv({
      'workspace-link-status': 'success',
      'environment-uids-json': '{"prod":"env-prod"}'
    });

    expect(rendered).toContain('POSTMAN_REPO_SYNC_WORKSPACE_LINK_STATUS="success"');
    expect(rendered).toContain(
      'POSTMAN_REPO_SYNC_ENVIRONMENT_UIDS_JSON="{\\"prod\\":\\"env-prod\\"}"'
    );
  });

  it('writes reporter logs to stderr', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reporter = new ConsoleReporter();

    reporter.info('info message');
    reporter.warning('warn message');

    expect(errorSpy).toHaveBeenCalledWith('info message');
    expect(errorSpy).toHaveBeenCalledWith('warning: warn message');
  });

  it('resolves non-GitHub branch and repository from CI context', () => {
    const config = parseCliArgs([], {
      BITBUCKET_BRANCH: 'feature/non-github-ref',
      BITBUCKET_WORKSPACE: 'acme',
      BITBUCKET_REPO_SLUG: 'payments-api'
    });

    const inputs = resolveInputs(config.inputEnv);

    expect(inputs.currentRef).toBe('');
    expect(inputs.githubHeadRef).toBe('');
    expect(inputs.githubRefName).toBe('feature/non-github-ref');
    expect(inputs.repository).toBe('acme/payments-api');
  });
});
