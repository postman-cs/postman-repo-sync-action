/* global console, fetch, process */
import { pathToFileURL } from 'node:url';

const DEFAULT_E2E_REPOSITORY = 'postman-cs/postman-actions-e2e';
const DEFAULT_E2E_WORKFLOW = 'e2e.yml';
const DEFAULT_E2E_REF = 'main';
const GITHUB_API_VERSION = '2026-03-10';

export function buildCorrelationId({ repository, runId, runAttempt, refName }) {
  return `${repository}-${runId}-${runAttempt}-${refName}`.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

export function normalizeSuite(value) {
  const suite = value?.trim() || 'smoke';
  if (suite !== 'smoke' && suite !== 'full') {
    throw new Error(`E2E_GATE_SUITE must be smoke or full; got ${suite}`);
  }
  return suite;
}

export function buildDispatchInputs({ action, refName, correlationId, failureInjection, suite }) {
  return {
    action,
    ref: refName,
    gate_correlation_id: correlationId,
    failure_injection: failureInjection,
    suite
  };
}

export function normalizeRunDetails(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const source = payload.workflow_run ?? payload.run ?? payload;
  const id = source.id ?? source.workflow_run_id ?? payload.workflow_run_id ?? null;
  const url = source.url ?? source.run_url ?? source.api_url ?? payload.run_url ?? payload.api_url ?? null;
  const htmlUrl = source.html_url ?? source.workflow_url ?? payload.workflow_url ?? null;

  if (!id && !url && !htmlUrl) {
    return null;
  }

  return { id, url, htmlUrl };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function dispatchE2e({ token, repository, workflow, workflowRef, action, refName, correlationId, failureInjection, suite }) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const payload = {
    ref: workflowRef,
    inputs: buildDispatchInputs({ action, refName, correlationId, failureInjection, suite })
  };
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      body: JSON.stringify(payload)
    });
  } catch (networkError) {
    throw new Error(
      `POST ${url} failed with network error: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
      { cause: networkError }
    );
  }

  const text = await response.text();
  if (![200, 204].includes(response.status)) {
    throw new Error(`POST ${url} failed with HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  const token = requiredEnv('E2E_DISPATCH_TOKEN');
  const repository = requiredEnv('GITHUB_REPOSITORY');
  const runId = requiredEnv('GITHUB_RUN_ID');
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const refName = process.env.E2E_GATE_REF ?? requiredEnv('GITHUB_REF_NAME');
  const action = process.env.E2E_GATE_ACTION ?? repository.split('/').at(-1);
  const e2eRepository = process.env.E2E_GATE_REPOSITORY ?? DEFAULT_E2E_REPOSITORY;
  const e2eWorkflow = process.env.E2E_GATE_WORKFLOW ?? DEFAULT_E2E_WORKFLOW;
  const e2eWorkflowRef = process.env.E2E_GATE_WORKFLOW_REF ?? DEFAULT_E2E_REF;
  const correlationId =
    process.env.E2E_GATE_CORRELATION_ID ??
    buildCorrelationId({ repository, runId, runAttempt, refName });
  const failureInjection = process.env.E2E_GATE_FAILURE_INJECTION ?? '';
  const suite = normalizeSuite(process.env.E2E_GATE_SUITE);

  console.log(`Dispatching e2e monitor: action=${action} ref=${refName} suite=${suite} correlation=${correlationId}`);
  const dispatchPayload = await dispatchE2e({
    token,
    repository: e2eRepository,
    workflow: e2eWorkflow,
    workflowRef: e2eWorkflowRef,
    action,
    refName,
    correlationId,
    failureInjection,
    suite
  });
  const runDetails = normalizeRunDetails(dispatchPayload);
  if (runDetails?.htmlUrl ?? runDetails?.url) {
    console.log(`::notice::Live e2e monitor dispatched: ${runDetails.htmlUrl ?? runDetails.url}`);
  } else {
    console.log('::notice::Live e2e monitor dispatch accepted (no run details returned).');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
