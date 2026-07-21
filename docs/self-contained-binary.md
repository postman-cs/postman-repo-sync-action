# Self-contained binary (no npm / no Node)

For CI environments that cannot install npm packages or a Node.js runtime — locked-down Jenkins, Bitbucket Pipelines on a bare agent, boxes with no package-registry access — repo-sync ships as a single self-contained executable. It is a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html): the Node runtime and the entire bundle are baked into one file, so the target needs **no npm, no Node install, and no network access to a package registry**.

"Self-contained" means the *runtime* is bundled — it is not network-isolated. repo-sync calls Postman API and gateway endpoints throughout the run (see [Network requirements](#network-requirements)), and its commit modes shell out to `git` (see [Scope and limitations](#scope-and-limitations)).

The binary is built and smoke-tested natively in CI on every release (`.github/workflows/release.yml`) and attached as a GitHub Release asset. It carries the same code as the `action.yml` and npm CLI paths.

- **Current target:** `linux-x64` (glibc). Other targets (linux-arm64, win-x64, darwin-arm64) are not built yet.
- **First release with the binary:** the first `v*` tag published after this lands. Pin an explicit released version in the examples below.

## Get the binary

Download the release asset and mark it executable. Pin an explicit version:

```bash
VERSION=2.1.8   # set to the release that carries the binary
curl -fsSL -o postman-repo-sync \
  "https://github.com/postman-cs/postman-repo-sync-action/releases/download/v${VERSION}/postman-repo-sync-${VERSION}-linux-x64"
chmod +x postman-repo-sync

./postman-repo-sync --version   # -> matches ${VERSION}
```

If the repository or release is private, the browser-style URL above returns an HTML login page instead of the binary. Fetch it through the GitHub API with a token that has `contents:read`, or — recommended for locked-down environments — **mirror the asset once into your own artifact store** (Artifactory, Nexus, S3) and have CI pull it from there. That keeps the build offline from GitHub entirely and gives you a stable internal URL.

## Prove self-containment

The binary embeds its own runtime and never consults `PATH` for `node`. You can prove that with an empty environment:

```bash
# Reaches the CLI's own input validation with no Node on PATH:
env -i PATH=/nonexistent ./postman-repo-sync
# -> "project-name is required" (expected: it ran, then validated inputs)
```

This is the same assertion the release workflow runs before publishing the asset.

## Credentials

The self-contained binary resolves each credential from three sources, highest precedence first:

1. A CLI flag — `--postman-access-token <token>`, `--postman-api-key <key>`
2. The GitHub Action input env var — `INPUT_POSTMAN_ACCESS_TOKEN`, `INPUT_POSTMAN_API_KEY`
3. A plain environment variable — `POSTMAN_ACCESS_TOKEN`, `POSTMAN_API_KEY`

The plain-env fallback (3) is what makes Jenkins [`withCredentials`](https://www.jenkins.io/doc/pipeline/steps/credentials-binding/) work with no flags: whatever sets `POSTMAN_ACCESS_TOKEN` in the environment, the binary picks it up. See [Obtaining Credentials](credentials.md) for the full credential matrix.

`postman-access-token` is **required** — every asset operation (environment create/get/update, collection read, mock, monitor), plus workspace-to-repo linking and system-environment association, runs through the access-token gateway. The PMAK is not an asset-routing fallback; it only mints/re-mints the access token (and, if you enable it, seeds the generated CI workflow's `POSTMAN_API_KEY` secret). Because the access token is short-lived (~1–1.5h), store the long-lived **PMAK** in your CI/Jenkins secret store and mint the access token during the job (see the [Jenkins example](#jenkins-pipeline-example)) rather than storing a token that will expire.

### No runtime tool downloads

Unlike some sibling actions, the repo-sync **binary makes no runtime tool downloads on any path** — not even when a `postman-api-key` is supplied. With a PMAK it only mints the access token and runs a `GET /me` preflight; both are ordinary API calls. So there is no lint/CLI-install or breaking-change download to disable for a locked-down run.

One thing does carry a downstream network dependency: with `generate-ci-workflow` at its default (`true`), repo-sync **writes** a CI workflow file into the repo that, *when your CI later runs it*, `curl | sh`-installs the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-installation/) from `dl-cli.pstmn.io` and runs `postman login --with-api-key`. That is a requirement of the *generated pipeline*, executed by your CI later — not of this binary. If your downstream runners are also locked down, either set `generate-ci-workflow: false`, or pre-provision the Postman CLI and mirror `dl-cli.pstmn.io` for those runners.

### Minting an access token

Mint a short-lived access token from a service-account PMAK immediately before the run (TTL ~1–1.5h). Mint against the API base for your region — `api.getpostman.com` for US, `api.eu.postman.com` for [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/) — and pass the matching `--postman-region` to the binary:

```bash
POSTMAN_REGION=us                                          # EU data residency: eu
case "$POSTMAN_REGION" in
  eu) POSTMAN_API_BASE="https://api.eu.postman.com" ;;
  *)  POSTMAN_API_BASE="https://api.getpostman.com" ;;
esac

resp="$(curl -fsSL -X POST "$POSTMAN_API_BASE/service-account-tokens" \
  -H "x-api-key: $POSTMAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$POSTMAN_API_KEY\"}")"

# The endpoint returns the token as either "access_token" or a nested
# session "token" -- accept both, matching the production extractor.
POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$POSTMAN_ACCESS_TOKEN" ] || \
  POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$POSTMAN_ACCESS_TOKEN" ] || { echo "token mint failed" >&2; exit 1; }
export POSTMAN_ACCESS_TOKEN

# Pass only the minted access token to the binary. Dropping the PMAK keeps the
# run least-privilege and avoids the credential-identity preflight warning that
# fires when the PMAK and access token resolve to different parent orgs.
unset POSTMAN_API_KEY
```

A token minted from the US endpoint is not valid against the EU API (and vice versa), so the mint base and `--postman-region` must match. Store the PMAK in your CI secret store and mint on demand; do not persist the access token.

## Network requirements

The binary bundles its runtime, but repo-sync is an online operation. The agent needs outbound network access (direct or via an HTTP/HTTPS proxy) to Postman for the entire run — token minting is only the first call; every subsequent environment, collection, mock, monitor, linking, and system-env mutation goes over the network too, and most of them hit the Bifrost gateway/proxy host rather than the public API host.

On agents that enforce an outbound allowlist, allow **all** of the following (prod defaults). The region only changes the API host; the Bifrost, iapub, and fallback hosts are the same for US and EU:

| Host | Purpose |
| --- | --- |
| `api.getpostman.com` (US) / `api.eu.postman.com` (EU) | Public API — token minting, `GET /me` preflight |
| `bifrost-premium-https-v4.gw.postman.com` | Bifrost proxy — the access-token asset gateway (environments, collections, mocks, monitors) plus linking and system-env association |
| `iapub.postman.co` | Session identity / team scope (`/api/sessions/current`) |
| `go.postman.co` | Cold serial fallback for the Bifrost proxy (`/_api`) |
| `catalog-admin.postman-account2009.workers.dev` | Workspace-to-repo linking worker — reached only when `workspace-link-enabled` is `true` (the default) |

Allowlisting only the API host is **not** enough: credential preflight and the asset-gateway calls will fail even though minting succeeds. Note two hosts that are *not* contacted by the binary: `web.postman.co` appears only inside the `spec-version-url` output string (never fetched), and `dl-cli.pstmn.io` is contacted only by the *generated* CI workflow when your CI later runs it (see [No runtime tool downloads](#no-runtime-tool-downloads)) — add it to the *downstream* runner's allowlist, not this one, and only if you keep workflow generation on.

Pre-minting the access token on a connected host and injecting it as `POSTMAN_ACCESS_TOKEN` removes the mint call from the agent, but **not** the requirement — the agent still must reach the gateway hosts above to do the actual work. A host with no route to Postman (direct or proxied) cannot run repo-sync. Only the package-registry and Node-runtime dependencies are eliminated; Postman connectivity is not.

## Run

Run from **inside the git checkout** you want to sync — repo-sync writes artifacts under `postman/` and `.postman/` and (in commit modes) commits them. Inputs are the same kebab-case names as [`action.yml`](../action.yml), passed as `--<input-name> <value>`:

```bash
export POSTMAN_ACCESS_TOKEN="<minted-token>"

./postman-repo-sync \
  --project-name core-payments \
  --workspace-id ws-123 \
  --baseline-collection-id col-baseline \
  --smoke-collection-id col-smoke \
  --contract-collection-id col-contract \
  --environments-json '["prod","stage"]' \
  --repo-write-mode commit-only \
  --postman-region us \
  --result-json postman-repo-sync-result.json
```

- `--repo-write-mode` controls git side effects: `none` (write files in the workspace only), `commit-only` (commit, no push), `commit-and-push` (commit and push to the checked-out ref — needs push credentials on that ref). Commit modes require `git` on the agent (the binary bundles Node, not git).
- `--result-json <path>` writes the machine-readable result (default `postman-repo-sync-result.json`); `--dotenv-path <path>` emits shell-sourceable variables.
- Reuse existing assets by passing `--workspace-id`, the `--*-collection-id` flags, `--mock-url`, and `--monitor-id` so reruns refresh in place instead of creating new ones.
- For org-mode tenants, pass `--team-id <team-id>` (or set `POSTMAN_TEAM_ID`).
- `--generate-ci-workflow false` skips writing the Postman-CLI-based CI workflow (which otherwise carries a downstream `dl-cli.pstmn.io` dependency — see [No runtime tool downloads](#no-runtime-tool-downloads)).
- There is also a `gc` subcommand (`postman-repo-sync gc --all-previews --dry-run`) for garbage-collecting preview/channel asset sets; it is marker-guarded and never deletes assets it did not create.

## Jenkins pipeline example

The binary must run on a **linux-x64 agent** — it is a Linux ELF and cannot execute on a Windows agent. The Jenkins credential stores the long-lived **PMAK**; the pipeline mints a short-lived access token from it in-job and exports it as `POSTMAN_ACCESS_TOKEN`, so the binary picks it up via the plain-env fallback with no flag. Do **not** store the access token itself in Jenkins — it expires in ~1–1.5h and a stored copy will eventually be stale.

```groovy
pipeline {
  // Requires a Linux x64 agent. Swap 'linux' for your instance's label.
  agent { label 'linux' }

  environment {
    REPO_SYNC_VERSION = '2.1.8'   // set to the release that carries the binary
    POSTMAN_REGION = 'us'         // EU data residency: 'eu'
  }

  stages {
    stage('Fetch binary') {
      steps {
        sh '''
          set -eu
          # Prefer your internal mirror in locked-down environments:
          URL="https://github.com/postman-cs/postman-repo-sync-action/releases/download/v${REPO_SYNC_VERSION}/postman-repo-sync-${REPO_SYNC_VERSION}-linux-x64"
          curl -fsSL "$URL" -o postman-repo-sync
          chmod +x postman-repo-sync
          ./postman-repo-sync --version
        '''
      }
    }
    stage('Repo sync') {
      steps {
        // Bind the PMAK, mint a fresh access token, then run -- all in one shell so the
        // minted token stays in scope. The binary reads it from POSTMAN_ACCESS_TOKEN
        // (no --postman-access-token flag); the PMAK is unset before the binary runs.
        withCredentials([string(credentialsId: 'postman-api-key', variable: 'POSTMAN_API_KEY')]) {
          sh '''
            set +x          # Jenkins runs sh with -x by default; disable it BEFORE touching the PMAK
            set -eu
            case "$POSTMAN_REGION" in
              eu) API_BASE="https://api.eu.postman.com" ;;
              *)  API_BASE="https://api.getpostman.com" ;;
            esac
            resp="$(curl -fsSL -X POST "$API_BASE/service-account-tokens" \
              -H "x-api-key: $POSTMAN_API_KEY" -H "Content-Type: application/json" \
              -d "{\\"apiKey\\":\\"$POSTMAN_API_KEY\\"}")"
            # Accept both response shapes: "access_token" or a nested session "token".
            POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)"
            [ -n "$POSTMAN_ACCESS_TOKEN" ] || \
              POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)"
            [ -n "$POSTMAN_ACCESS_TOKEN" ] || { echo "token mint failed" >&2; exit 1; }
            export POSTMAN_ACCESS_TOKEN
            # Pass only the minted access token: least-privilege, and avoids the
            # credential-identity preflight warning on mismatched parent orgs.
            unset POSTMAN_API_KEY
            ./postman-repo-sync \
              --project-name core-payments \
              --workspace-id ws-123 \
              --baseline-collection-id col-baseline \
              --repo-write-mode commit-only \
              --postman-region "$POSTMAN_REGION" \
              --result-json "$WORKSPACE/postman-repo-sync-result.json"
          '''
        }
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: 'postman-repo-sync-result.json', allowEmptyArchive: true
    }
  }
}
```

## Scope and limitations

- **Platform:** linux-x64 (glibc) only. arm64/Windows/macOS targets are not built yet.
- **Network:** not air-gapped — requires outbound access to the Postman API/gateway hosts for the whole run. See [Network requirements](#network-requirements).
- **git:** the binary bundles Node, not git. `--repo-write-mode commit-only` and `commit-and-push` shell out to `git`, which must be on the agent; `commit-and-push` also needs push credentials on the checked-out ref. `--repo-write-mode none` writes files only and needs no git.
- **Generated CI workflow:** with `generate-ci-workflow: true` (default), the workflow file repo-sync writes installs the Postman CLI from `dl-cli.pstmn.io` and runs `postman login` *when your CI later executes it*. That is a downstream requirement, not one of this binary. Disable with `generate-ci-workflow: false` or pre-provision the CLI on those runners.
- **Version:** the embedded `--version` and telemetry version are baked in at build time from the release tag; the versioned filename (`postman-repo-sync-<version>-linux-x64`) also carries it.
```

