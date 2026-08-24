# Portable Environment Provisioning PoC

Status: Implemented; live validation pending
Owner: Postman CSE
Review outcome: Approved with conditions
Implementation status: Core implemented on this feature branch; provider adapters and live validation profiles remain pending

## Executive decision

Environment provisioning belongs in `postman-repo-sync-action`.

Repo-sync already owns Postman workspace identity, environment UID state, authenticated asset writes, redacted exports, and retry convergence. Bootstrap continues to own initial workspace, specification, and collection setup. Customer pipelines remain thin adapters: they provide a JSON definition and inject resolved credentials only when collections run.

This ownership decision is closed for the PoC. The implementation must not move environment creation to bootstrap, add customer-specific provisioning code, or add a vault provider to repo-sync.

The implementation preserves the automated-test-backed rich input shape while separating durable customer provisioning from the existing branch-scoped environment loop. Durable environments run through a dedicated planner and executor within repo-sync.

## Existing-system inventory

The authoritative implementation is `postman-cs/postman-repo-sync-action`. It exposes the same contract through a GitHub Action, CLI, npm distribution, and self-contained binaries.

The existing system provides:

- Postman workspace and asset discovery through API-key or access-token gateway clients;
- tracked environment UIDs in `.postman/resources.yaml`;
- redacted environment exports under the generated artifact tree;
- canonical, channel, preview, gated, and legacy branch decisions;
- action-owned preview/channel markers, TTL, and garbage collection;
- action-owned Mock environment creation;
- exact-name discovery and ambiguous-create reconciliation;
- repository write modes and generated workflow support.

PR #136 supplies the environment YAML and tracked-state foundation on which this feature depends. It must be merged and released before this feature is released.

The implementation includes rich definitions, `refresh` and `create-only` behavior, empty secret slots, strict validation, and focused automated-test evidence. Source and automated tests establish implementation status; live provider validation remains separate evidence.

## Problem evidence

Customers need to create several durable Postman environments such as development, development refresh, integration, or other named stages. Each environment may contain a complete variable set, not only `baseUrl`:

```json
[
  {
    "slug": "dev",
    "values": [
      { "key": "baseUrl", "value": "https://dev.example.com" },
      { "key": "variable1", "value": "value1" },
      { "key": "variable2", "value": "value2", "enabled": false },
      { "key": "jwtToken", "type": "secret" }
    ]
  }
]
```

The resolved JWT is supplied by an external secret store at runtime. It must not be written to the definition, Postman environment, tracked state, generated artifacts, action outputs, or logs.

The existing branch environment path is insufficient for durable provisioning. In the initial ADO caller, every triggered branch is classified as a channel while the configured canonical branch is not triggered. Coupling `create-only` to canonical branch execution therefore makes the feature unreachable without changing the customer's branch topology. A reusable implementation must distinguish durable customer environments from branch-owned preview/channel environments.

## Scope

The PoC includes:

- complete customer environment definitions with multiple values;
- an unchanged legacy string-entry contract alongside a separate rich-object durable contract;
- durable environment planning independent of preview/channel asset naming;
- create-if-absent with preservation of an existing environment;
- explicit full replacement when the customer elects declarative ownership;
- empty Postman secret slots and runtime-only credential injection;
- workspace-scoped identity validation, UID tracking, redacted export, retry convergence, and value-free audit output;
- caller-supplied file or inline ingestion normalized to the same JSON string;
- ADO/Windows and a second non-ADO/Linux validation profile.

The PoC excludes:

- vault lookup or provider plugins inside repo-sync;
- storing resolved secrets in Postman;
- deletion, rename, promotion, retirement, or rollback deletion;
- per-environment lifecycle policy;
- ephemeral preview/channel lifecycle changes;
- changes to the action-owned Mock environment;
- a generalized templating or transformation language.

## Invariants

1. Repo-sync is the sole shared owner of schema validation, planning, Postman mutation, UID tracking, redacted export, and convergence.
2. Durable customer environments and ephemeral branch-owned environments are separate resource classes. Neither may adopt or mutate the other's resources.
3. The logical identity is `(workspace ID, project identity, resource class, environment slug)`. A Postman UID is the durable binding. A display name is a discovery convention, not identity by itself.
4. Definitions never contain Postman UIDs, workspace IDs, export paths, action markers, vault references, or provider-specific fields.
5. A secret value must be omitted or empty. Validation rejects a populated secret before any Postman discovery or mutation and does not echo it.
6. Removal or rename never deletes a Postman environment in the PoC.
7. All definitions are parsed and all known identities are validated before the first create or update.
8. A create may be retried only through exact-name reconciliation. The implementation never blindly repeats an ambiguous POST.
9. Cross-process applies are serialized by the calling workflow over the exclusive state repository/ref/resources-file domain. In-process single-flight remains a defense, not a distributed lock, and cross-repository apply is unsupported.
10. Generated state and logs contain no resolved runtime credential.
11. Existing callers that do not opt into durable provisioning retain their current behavior.

## Public contract

### Definition input

The shared action and CLI accept one normalized JSON string. A caller may construct it inline or read it from a repository-confined file; repo-sync does not need separate file-path semantics in the PoC.

The portable durable shape is an array of rich objects:

```ts
type DurableEnvironmentDefinition = {
  slug: string;
  values: Array<{
    key: string;
    value?: string;
    type?: 'default' | 'secret';
    enabled?: boolean;
  }>;
};
```

Normalization defaults `value` to `""`, `type` to `"default"`, and `enabled` to `true`. Rich `values` are the complete creation template. Under `refresh` they are authoritative desired state; under `create-only` they seed only a missing environment and are not compared with or applied to an existing environment.

The schema is exact-field: unknown root, environment, or value fields fail. The PoC limits are 1 MiB of UTF-8 JSON, 100 environments, 500 values per environment, 256 Unicode scalar values per slug or key, and 256 KiB of UTF-8 per literal value. Slugs and keys reject C0/C1 control code points and bidirectional formatting code points U+061C, U+200E–U+200F, U+202A–U+202E, and U+2066–U+2069. Slugs also reject path separators, `.`/`..`, absolute or drive-qualified paths, and values that collide after Unicode normalization and case folding. The action-owned `x-pm-onboarding` variable key is reserved. Strings such as `__proto__`, `prototype`, and `constructor` are otherwise ordinary slug/key data; every implementation map must use a null prototype and every lookup must use an own-property check. Duplicate slugs and duplicate keys fail before discovery.

String entries remain accepted only by the unchanged legacy `environments-json` path. Durable `plan` and `apply` require rich object entries. There is no implicit expansion of a durable string into generated values.

The public contract is fixed as follows:

| Action input | CLI flag | Type and default | Allowed values or shape | Legacy interaction |
| --- | --- | --- | --- | --- |
| `durable-environments-json` | `--durable-environments-json` | JSON string, default `[]` | Rich object array above | Separate from `environments-json`; never consumes legacy strings or runtime URL maps |
| `durable-environment-policy` | `--durable-environment-policy` | string, default `create-only` | `create-only`, `refresh` | Does not change legacy branch-owned refresh behavior |
| `durable-environment-operation` | `--durable-environment-operation` | string, default `off` | `off`, `plan`, `apply` | Existing callers remain off and behaviorally unchanged |
| `durable-environment-uids-json` | `--durable-environment-uids-json` | JSON object string, default `{}` | slug to Postman UID | Never reads or writes legacy `environment-uids-json` |
| `durable-project-key` | `--durable-project-key` | string, default empty | required for `plan` or `apply`; stable logical key | Does not replace display-oriented `project-name` |
| `durable-state-ref` | `--durable-state-ref` | string, default empty and resolved to `canonical-branch` | one persistent trusted Git ref | Never writes durable state only to a transient triggering ref |

`off` performs no durable parsing, discovery, output, state migration, or mutation. `plan` parses definitions and emits an offline plan; with read credentials it may add live observations, but never writes. `apply` requires trusted mutation authorization, a provider lock, an authenticated state-ref fetch plus dry-run publication preflight, and Postman capabilities before its first write. Final publication still uses compare-and-push reconciliation and can fail if repository authority or state changes after the preflight. Supplying definitions alone never authorizes mutation.

Legacy `environments-json`, `environment-uids-json`, and `env-runtime-urls-json` remain exclusively branch-owned. Durable inputs do not change their parsing, defaults, outputs, naming, marker, TTL, or GC behavior. A durable and branch-owned entry may not resolve to the same normalized display name or Postman UID. Such a collision, including a Mock or preview/channel marker collision, fails before mutation.

File ingestion belongs in provider templates. An adapter reads a repository-confined UTF-8 JSON file, applies the same size limit, and passes the content unchanged. Inline JSON uses the identical action boundary. Evidence records only a SHA-256 digest of the payload.

### Lifecycle policies

`create-only` means:

- create an absent environment;
- validate and reuse an existing tracked durable UID or an explicitly supplied UID that passes adoption checks; exact-name discovery alone may report a candidate but never authorizes reuse;
- do not replace any existing values;
- export the live redacted environment after reuse.

`refresh` means:

- create an absent environment;
- replace the complete values array only for an existing tracked durable UID or an explicitly supplied UID that passes adoption checks;
- treat the definition as authoritative desired state.

The policy is global for the PoC. `create-only` is the safe initial-adoption policy. A customer moves to `refresh` only after explicitly accepting ownership of the complete value set.

### Runtime credential boundary

`{ "key": "jwtToken", "type": "secret" }` declares a logical runtime slot. Provisioning may create only an empty Postman secret variable for that slot.

Only the collection-run adapter, and only when a collection run is requested, resolves the actual value after successful provisioning or environment selection. It masks the value with native CI controls and injects it only into the selected collection run. Plan and provisioning paths never request it. Azure Key Vault, GitHub secrets, AWS, GCP, Jenkins credentials, and other providers all terminate at the same masked process-variable boundary. Repo-sync does not know which provider supplied the value.

Repo-sync cannot infer sensitivity from a key name. The no-persistence guarantee applies to values declared `type: secret`; callers must classify every credential as secret. A credential mislabeled `default` is treated as a literal and may be persisted.

Runtime binding requirements are owned by the runner invocation. A missing required binding fails the collection-run phase, not environment provisioning. For the PoC, existing isolated CI runners and masked variables are accepted with the residual risk that command-line overrides may be visible to sufficiently privileged host processes. The validation evidence must show that values are absent from normal logs, outputs, cloud environments, and generated files. A safer transport can be added later without changing the definition shape.

## Planner and executor design

The implementation is a bounded module within repo-sync, not additional customer or bootstrap code.

### Plan phase

The planner:

1. parses and normalizes the complete input;
2. rejects unknown fields, duplicate slugs, duplicate keys, reserved markers, populated secret values, excessive sizes, and conflicting legacy inputs;
3. resolves the initial durable display name as `${project-name} - ${slug}` and validates it against persisted identity;
4. loads one workspace environment snapshot;
5. validates every supplied/tracked UID against the expected workspace and exact name;
6. fails on duplicate exact-name matches or stale bindings;
7. builds an immutable in-memory execution plan containing normalized desired values and a canonical normalized-definition digest;
8. emits a separate value-free projection with the digest and runtime slot keys; offline plans use action `unresolved`, while credentialed live plans use `create`, `reuse`, `replace`, or `review-required` after discovery;
9. performs no Postman writes.

Planning is allowed for trusted or untrusted pull requests because it needs neither a vault credential nor mutation authority. If workspace discovery requires privileged Postman credentials, untrusted execution is limited to offline schema planning.

### Apply phase

The executor consumes the successful in-memory plan from the same invocation. `apply` always replans from a fresh workspace snapshot while holding the apply lock. A plan-only result is advisory and is never replayed as executable input or mutation authorization. Repository review of the immutable caller commit authorizes the input; the emitted normalized-definition digest provides evidence that plan and apply used the expected semantic definition.

1. revalidates all planned UID, workspace, exact-name, ownership-class, and existence observations before the batch's first mutation;
2. rechecks the affected binding immediately before each create, reuse, or replacement because the provider lock cannot prevent a Postman UI or unrelated client change;
3. creates, reuses, or replaces in stable input order;
4. reconciles an ambiguous create through an exact-name read;
5. live-reads the resulting environment by UID and verifies its workspace-scoped exact-name binding;
6. for create and refresh, compares normalized non-secret values and secret-slot metadata with the definition;
7. for create-only reuse, records `reused-preserved`, does not compare live values with the creation template, and records an observed digest;
8. produces a redacted export;
9. stages and validates generated files, promotes the resources manifest last, and publishes the Git commit as the atomic repository unit;
10. emits one structured, value-free result.

An entry result contains only slug, policy, action (`unresolved`, `review-required`, `create`, `reuse`, `reused-preserved`, or `replace`), UID when observed, runtime slot keys, and failure category. Offline `unresolved` entries omit UIDs; a live `review-required` entry exposes the candidate UID for explicit operator review but does not add it to the validated UID output. Errors are single-line sanitized and length-capped.

### Partial failure

Postman does not provide a multi-environment transaction. If environment A succeeds and environment B fails, A remains. The action does not compensate by deleting A.

The result identifies cloud-applied and state-published status per entry. Previously tracked bindings converge automatically. For a newly created environment whose state was not published, the next run reports the exact-name candidate and performs no POST. The operator or trusted adapter must take the UID from the sanitized recovery result, review it, and supply it through `durable-environment-uids-json`; apply then validates and binds it. Exact-name detection prevents a duplicate create but does not itself authorize adoption.

If cloud mutation succeeds but repository state publication fails, the core Action emits the sanitized recovery result and UID map as step outputs before throwing; a shipped provider adapter materializes that output outside generated/staged paths and uploads it under an `always()` condition. The CLI atomically leaves the same result at its documented stable `--result-json` path before returning nonzero. The run reports `cloud-applied/state-not-published`. Core Action output emission is implemented here; provider materialization/upload remains adapter work and is not claimed by this PR.

There is no atomic transaction across Postman and Git. A failed batch never publishes partial authoritative repository state. The recovery result is evidence, not state.

## State and ownership

The desired definition remains customer-authored and secret-free. Generated environment YAML is redacted observed state, not desired input.

The feature introduces `.postman/resources.yaml` state v3 after PR #136 state v2. The existing `canonical.environments` artifact-ref-to-UID map remains the sole UID authority. State v3 adds metadata without duplicating the UID:

```yaml
version: 3
workspace:
  id: <workspace UID>
canonical:
  environments:
    ../postman/environments/<stable-name>.environment.yaml: <Postman UID>
environmentProvisioning:
  projects:
    <durable-project-key>:
      environments:
        <slug>:
          artifact: ../postman/environments/<stable-name>.environment.yaml
          displayName: Payments API - dev
          policy: create-only
          definitionDigest: env-definition-v1:sha256:<lowercase hex>
```

The metadata artifact reference must resolve to exactly one UID in `canonical.environments`. A missing, duplicated, malformed, or conflicting reference fails before Postman mutation. Unknown state fields are preserved by v3 writers.

On first create or explicit adoption, the display name is derived exactly as `${project-name} - ${slug}` and persisted. Later runs use `durable-project-key` plus slug as logical identity and require the newly derived display name to equal the persisted value. A `project-name` or slug change that would alter the display name fails and is reported as an unsupported rename; it never silently creates a replacement.

`definitionDigest` uses the versioned `env-definition-v1` algorithm. The implementation first constructs an object with keys in this exact order: `schema`, `workspaceId`, `projectKey`, `projectName`, `policy`, `environments`. Each environment object uses `slug`, `values`; each normalized value object uses `key`, `value`, `type`, `enabled`. Defaults are materialized, JSON objects contain no other keys, JSON is serialized without whitespace as UTF-8, and environment/value array order is preserved. SHA-256 is encoded as lowercase hexadecimal and prefixed `env-definition-v1:sha256:`. File whitespace, input object-key order, and inline versus file transport therefore do not change the digest; array reordering does.

The normative test vector is:

```text
{"schema":"env-definition-v1","workspaceId":"ws-123","projectKey":"payments","projectName":"Payments API","policy":"create-only","environments":[{"slug":"dev","values":[{"key":"baseUrl","value":"https://dev.example.com","type":"default","enabled":true},{"key":"jwtToken","value":"","type":"secret","enabled":true}]}]}
env-definition-v1:sha256:1094bacc7eab489cc441ea5057ab61c268af1ca8e5d6eab17016df9cd7a62187
```

Action, CLI, file, and inline fixtures must produce that digest. Any algorithm change requires a new identifier and state compatibility decision.

`lastVerifiedAt` and run results remain in the value-free run report rather than versioned repository state, so unchanged applies do not create commits. A create-only reuse stores the normalized input-definition digest only as input evidence; it does not claim that preserved live values match the definition. Its observed digest belongs in the run report and redacted export.

No resolved secret, provider reference, or provider-side binding name is persisted. Logical environment-variable slot keys may appear in redacted exports and value-free results.

### State v2 migration and downgrade

State v2 canonical environment mappings are never implicitly reclassified as durable. A durable binding is created only from a new create result or an explicitly supplied durable UID that passes workspace, exact-name, collision, and ownership review. If that UID already appears at the expected canonical artifact ref, v3 metadata references it; any other existing mapping or resource-class claim fails.

Absent `durable-environments-json` with operation `off` disables the feature. A present empty array with `plan` or `apply` produces only an orphan report for previously tracked durable entries and never deletes them.

Downgrade requires reverting durable caller inputs, adapter version, action version, and the compatible state commit together. A v2 action must not run against v3 state unless that exact release has proven unknown-field preservation. State parsing, migration, and downgrade compatibility are verified before cloud mutation.

The existing branch-owned preview/channel marker contract remains unchanged. The Mock environment remains action-owned and refresh-managed outside durable customer provisioning.

### First binding and adoption

An existing durable environment may be reused only when its tracked UID validates, or when the caller supplies its UID through `durable-environment-uids-json` as explicit reviewed adoption intent. Exact-name discovery alone may report a candidate but never authorizes adoption or apply.

A newly created environment is bound directly from the create result. The planner rejects any candidate UID or normalized display name already claimed by branch-owned state, a preview/channel ownership marker, the Mock environment, another durable slug, or more than one live exact-name match. Stable display-name collisions fail; the PoC does not auto-rename.

## Trigger and authorization model

Durable provisioning is authorized by operation intent and trust, not by whether the current branch happens to be classified as a channel.

Trust classification, operation selection, and offline schema validation occur before repo-sync requests mutation credentials. A live plan receives only the read capability it requires. Apply validates the caller's operation-level authorization, workspace/team parent identity, and required read/write capabilities before its first mutation. The runtime JWT is acquired later by the collection-run adapter and is unrelated to Postman provisioning authorization.

### Durable state ref and apply lock

One configured `durable-state-ref` is the sole repository state writer for `(workspace ID, durable project key)`. It defaults to the configured canonical branch but may be a persistent trusted integration branch for the PoC. Apply from any event is allowed only when it runs on that ref or when the adapter can compare-and-swap publish the resulting state commit to that ref. Before cloud mutation, repo-sync authenticates a fetch and dry-run push to the state ref; unavailable access fails the preflight. Final compare-and-push remains authoritative and fails closed if the ref or permission changes afterward. A manual or channel run must not leave durable bindings only on its triggering ref.

One repository and state ref is the exclusive apply owner for each `(workspace ID, durable project key)` tuple. Other repositories are plan-only. Cross-repository apply is unsupported until a distributed lease exists.

Because state v3 is one shared file, the apply lock domain is `(state repository, durable-state-ref, .postman/resources.yaml)`, not only the project key. The lock covers state-ref checkout, workspace snapshot, plan, all Postman writes, live verification, staged artifact validation, and state-ref commit. CAS remains a defense against unrelated Git writers rather than the primary concurrency mechanism. Offline and plan-only runs need no mutation lock.

Shipped provider templates statically declare a deterministic lock and have contract tests for it. Custom callers are supported only when they provide an equivalent lock. Repo-sync cannot reliably detect a missing external lock without a future lease-token protocol; that limitation is an explicit residual risk, not a claimed runtime check.

| Event | Offline plan | Live plan | Durable apply | Branch-owned sync |
| --- | --- | --- | --- | --- |
| Fork or untrusted PR | yes | no | no | gated |
| Same-repository PR | yes | optional read-only | no | existing behavior |
| Trusted canonical run | yes | yes | yes | existing behavior |
| Trusted channel run | yes | yes | only when explicitly enabled | existing behavior |
| Authorized manual run | yes | yes | yes | optional |
| Scheduled drift run | yes | yes | no in PoC | existing behavior |

This allows the initial ADO caller to provision durable environments from its trusted branch topology without pretending channel-owned assets are canonical. The adapter must explicitly request durable `apply`; merely supplying definitions does not authorize mutation.

Each provider adapter must serialize durable apply runs for the state-file lock domain above and enforce the repository's exclusive ownership of its workspace/project tuples. The PoC documentation must give an ADO locking pattern and a GitHub `concurrency` pattern. Other providers must supply an equivalent lock before being called supported.

## Decision matrix

| Condition | Result before mutation |
| --- | --- |
| Durable operation absent or `off` | Existing behavior unchanged; no durable parsing or state migration |
| `plan` without read credentials | Value-free entries with action `unresolved`; never writes |
| `plan` with read credentials | Value-free live `create`/`reuse`/`replace` observations; never writes |
| `apply` | Fresh in-memory replan under lock, trust/capability/state-ref validation, then writes |
| Definitions supplied while operation is `off` | No durable action; definitions alone do not authorize mutation |
| Malformed, oversized, or unknown-field definition | Fail |
| Populated `type: secret` value | Fail without echo |
| Duplicate slug or variable key | Fail |
| String entry in durable input | Fail; strings remain legacy-only |
| Missing workspace for apply | Fail |
| Missing Postman mutation credential | Fail before live discovery or writes |
| Credential belongs to wrong team/workspace parent | Fail with zero writes |
| Valid identity lacks required read/write capability | Fail with zero writes |
| State ref authenticated fetch or dry-run publication unavailable | Fail before cloud mutation |
| State ref, generated paths, or publication authority changes after preflight | Fail final publication and emit value-free recovery evidence; never claim state publication |
| Stale UID, wrong workspace, or wrong exact name | Fail |
| Duplicate exact-name matches | Fail |
| Untracked exact-name candidate without explicit UID | Report candidate and fail adoption |
| Explicit UID adoption passes ownership checks | Plan reuse or replacement according to policy |
| UID/name claimed by branch, Mock, preview/channel marker, or another durable slug | Fail |
| Same normalized display name in durable and branch-owned definitions/state | Fail |
| Current project name derives a different name than persisted state | Fail as unsupported rename |
| Missing environment | Plan create |
| Existing environment plus `create-only` | Plan reuse without PUT |
| Existing environment plus `refresh` | Plan full replacement |
| Removed or renamed definition | Retain and report; never delete |
| Runtime secret binding missing | Provisioning unaffected; runner applies its own requirement |
| Untrusted execution requests apply | Fail or force offline plan |
| Workspace or ownership drifts between snapshot and pre-write validation | Fail the batch before its first write and emit the new plan digest |
| Missing lock in a shipped adapter | Adapter contract failure |
| Custom caller without an equivalent lock | Unsupported residual risk; repo-sync cannot reliably detect it |

## Alternatives considered

### Put creation in bootstrap

Rejected. Bootstrap does not own ongoing environment state, exports, UID convergence, or repository updates. Splitting environment creation and reconciliation between two actions would create dual ownership.

### Put provider or vault resolution in repo-sync

Rejected. It would couple the shared action to customer infrastructure and expose resolved credentials to provisioning, persistence, and logging paths that do not need them.

### Add a separate manifest-file contract

Deferred. File and inline callers can already normalize to the same JSON string. A second ingestion surface adds path, encoding, size, documentation, CLI, and bundle work without proving a different provisioning capability.

### Continue using the branch environment loop

Rejected. Durable customer environments and preview/channel environments have different identities, authorization, marker, TTL, and deletion semantics. Sharing a parser is acceptable; sharing lifecycle execution is not.

### Add deletion, promotion, or per-environment policy now

Rejected for the PoC. These require additional ownership and rollback decisions and are not needed to prove reusable creation, preservation, replacement, and runtime-secret isolation.

## Contract and release propagation

The target compatibility line is repo-sync v4 with resources state v3. The dependency and propagation matrix is:

| Surface | Authoritative repository/artifact | Owner | Current dependency | Target channel/version | Required evidence |
| --- | --- | --- | --- | --- | --- |
| State v2 dependency | `postman-cs/postman-repo-sync-action` PR #136 | repo-sync maintainers | state v1 / package 2.8.7 at the feature base | immutable v3.0.0 release with state v2 | merged release, migration tests, checksummed bundles |
| Durable source and Action | `postman-cs/postman-repo-sync-action` | repo-sync maintainers | v3.0.0 / state v2 | v4.0.0-rc.1 candidate, then v4.0.0 / state v3 | source tests, live profiles, release checks |
| CLI and npm | `@postman-cse/onboarding-repo-sync` | repo-sync maintainers | same source version | exactly v4.0.0-rc.1, then v4.0.0 | action/CLI contract parity and published-package smoke |
| Self-contained binaries | repo-sync release assets and checksums | repo-sync maintainers | same source version | exactly v4.0.0-rc.1, then v4.0.0 | entrypoint, platform, checksum, and bundle parity |
| ADO/Windows validation adapter | customer-neutral Azure Repos proof repository | Postman CSE with customer review | current branch-owned inputs | immutable candidate commit for validation; v4.0.0 for adoption | ADO lock, file normalization, vault-backed runtime binding, first/repeat runs |
| GitHub/Linux proof adapter | `.github/workflows/environment-provisioning-proof.yml` in `postman-cs/postman-repo-sync-action` | repo-sync maintainers | none | candidate-only proof workflow pinned to candidate bytes | GitHub concurrency, inline JSON, encrypted environment secret, first/repeat runs |
| Documentation and changelog | repo-sync README and `docs/` | repo-sync maintainers | v3 contract | v4 contract published with final release | exact inputs, state v3, migration, downgrade, secret boundary |
| First caller adoption | customer repository selected after validation | customer operator with Postman CSE | legacy inputs | released v4.0.0 plus compatible adapter | merged caller and successful production-like repeat run |

Release order is fixed: PR #136 v3.0.0 release → v4.0.0-rc.1 source and candidate adapters → both live validation profiles → final v4.0.0 action/npm/binaries/docs → final adapters pinned to v4.0.0 → customer adoption. No released adapter may point to a candidate, moving branch, or unchecksummed bundle.

A full immutable commit SHA plus checksummed archived bundles may be used for candidate validation. Neither that candidate nor an unmerged PR is a release.

## Migration and rollback

Migration begins with inventory of workspace, exact environment names and UIDs, tracked state, current non-secret values, branch tiers, caller OS/provider, and possible concurrent jobs.

The first live run uses `create-only`:

1. capture sanitized pre-change state and the existing UID map;
2. pin the immutable candidate action and adapter;
3. record explicit durable UID adoption intent for every pre-existing exact-name environment;
4. submit the full rich definition with empty secret slots from an immutable reviewed commit;
5. run advisory plan and record its canonical normalized-definition digest;
6. run apply from the same immutable definition; apply replans under lock and the evidence harness confirms the same semantic digest before mutation;
7. run Smoke/Contract, resolving the external credential only for those collection runs;
8. verify cloud values, UID state, redacted exports, and secret absence;
9. repeat unchanged and prove stable UIDs and zero duplicate assets.

Moving to `refresh` is a separate customer-approved step because it replaces the complete value set and may clear values maintained manually in Postman.

Rollback reverts the action version, adapter inputs, and compatible tracked-state commit together. It never automatically deletes a newly created environment. If `refresh` changed non-secret values, restore them from the captured sanitized definition. A prior resolved secret cannot be recovered from redacted state and must continue to come from the customer's vault at runtime.

## Verification plan

### Automated contract harness

The shared harness must cover:

- legacy-only compatibility and separate durable rich definitions;
- normalization defaults, schema limits, unknown fields, Unicode/control characters, prototype keys, duplicate slugs/keys, and reserved markers;
- populated-secret rejection with canary scans proving no echo;
- full preflight with zero writes for stale UID, wrong workspace/name, duplicate discovery, and mixed valid/invalid batches;
- absent Postman credentials, wrong team/workspace parent identity, and insufficient read/write capability with zero-write assertions;
- trust and offline-schema gates before mutation-credential acquisition, read-only credentials for live plan, and operation-level authorization for apply;
- create, create-only reuse, refresh replacement, and redacted live export;
- untracked exact-name candidate reporting during plan and rejection during apply, explicit UID adoption, branch-marker/Mock/resource-class collision, and one UID claimed by two classes;
- interrupted create and ambiguous-create reconciliation;
- cloud success plus repository failure followed by convergent retry;
- sanitized partial-result persistence for both failed Action and CLI invocations;
- removal/rename retention without deletion;
- durable execution on trusted canonical, trusted channel with explicit authorization, manual, PR, fork, and scheduled contexts;
- canonical normalized-definition digest stability, plan/apply semantic-digest comparison, and pre-write workspace drift rejection;
- project-name/project-key drift and persisted-display-name rename rejection;
- file and inline ingestion byte equivalence and identical normalized-definition digest;
- state v2-to-v3 migration, corrupt-state failure, unknown-field preservation, and coordinated downgrade;
- in-process single-flight, state-file lock-domain, exclusive apply-owner, and provider-lock contract tests;
- source/dist parity, CLI/action parity, typecheck, lint, and full regression suite.

### Portable validation profiles

The design is not called portable until it passes both profiles with sanitized evidence:

1. Azure DevOps on Windows with Azure Repos, a repository JSON file normalized by PowerShell, existing and new durable environments, Azure Key Vault mapped to a masked runtime variable, explicit apply authorization, and an overlapping-dispatch test proving serialization.
2. GitHub Actions on `ubuntu-24.04` with inline JSON, a GitHub encrypted environment secret, offline PR entries asserted as `unresolved`, credentialed plan observations, new and existing environments, apply retry, and an overlapping-dispatch test proving `concurrency` serialization.

At least one profile must exercise `create-only`, one customer-approved profile must exercise `refresh`, and both must repeat unchanged without UID churn or duplicate assets.

Evidence includes immutable candidate version, sanitized run link/log, payload and normalized-definition digests, before/after redacted snapshots, UID map, mutation counts, collection assertion results, secret-canary scan, and rollback rehearsal. Rollback succeeds only when original existing values are restored or preserved, newly created UIDs are retained and orphan-reported rather than deleted, compatible caller/state versions are restored together, and a repeat run creates no duplicate.

## Observability and operations

Every run emits one value-free provisioning summary containing:

- project/workspace identity hash;
- operation and policy;
- per-slug plan and result;
- Postman UID for successfully bound assets;
- runtime slot keys only;
- cloud-applied and state-published status;
- sanitized failure category and recovery instruction.

The action never logs the full definition payload because it may contain customer URLs or other sensitive non-secret configuration. Operators compare payload digests and redacted exports.

An orphan report lists tracked durable resources omitted or renamed by the current definition. It is informational only in the PoC. A future explicit, ownership-verified retirement design must be approved before deletion is added.

## Risks and conditions

The implementation remains approved only while these conditions hold:

- durable provisioning is implemented as a separate planner/executor path within repo-sync;
- legacy branch environment behavior remains compatible and independently tested;
- apply authorization is explicit and works with the initial ADO channel topology;
- ADO and GitHub adapters document and enforce a concurrency mechanism;
- runtime secret transport and its privileged-host residual risk are documented;
- PR #136 release compatibility and coordinated rollback are documented;
- orphan reporting exists while deletion remains unavailable;
- errors, outputs, logs, state, and artifacts pass secret-canary scanning.

## Readiness and claim boundaries

The status progression is monotonic:

- **Designed:** this RFC is accepted with its invariants, contract, trigger matrix, migration, rollback, and evidence plan.
- **Implemented:** source and every public/generated contract surface are aligned and all automated tests pass.
- **Validated:** the immutable candidate passes both real provider profiles, convergence, secret isolation, failure recovery, and rollback rehearsal.
- **Released:** compatible action, CLI, npm/binary artifacts, adapters, documentation, and state dependency are published immutably.
- **Adopted:** at least one real customer caller is merged on released versions and succeeds on first and repeated production-like runs with an identified operator.

Local tests do not prove validation. A vendor-run pilot does not prove adoption. The first customer pilot is one live validation profile, not a special code path and not the only portability evidence.

## Review decision

Review outcome: **APPROVE WITH CONDITIONS**.

The architecture, ownership, input shape, secret boundary, and lifecycle separation are implemented. Live provider profiles are still required before the status advances from Implemented to Validated. Any proposal to move ownership out of repo-sync, add provider-specific secret resolution, merge durable and ephemeral lifecycles, or introduce deletion requires a new design review rather than expanding this PoC.
