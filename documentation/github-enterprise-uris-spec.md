# GitHub Enterprise multi-host configuration

## Decision and scope

Implement **Crawl** for the rollout of [microsoft/vscode#338080](https://github.com/microsoft/vscode/pull/338080): support the new configuration while retaining **one selected GitHub.com client and one selected Enterprise client per extension host**. Simultaneous Enterprise clients and multiple accounts on the same host are follow-ups, not prerequisites.

Target `engines.vscode: "^1.141.0"` in [package.json](../package.json) as the compatibility boundary. VS Code enforces the stable minimum; Insiders users are expected to run the latest Insiders. A brief gap where early 1.141 Insiders builds do not yet understand the plural setting is accepted. Do not add runtime version/capability checks or legacy-setting write fallbacks to accommodate those snapshots.

Crawl is implemented in this branch; Walk and Run remain follow-up proposals. This specification was developed against extension revision `74fe08d0` and upstream PR head [`a3f9a6f0af8`](https://github.com/microsoft/vscode/commit/a3f9a6f0af8ccbe91872208fee714c2c471dc081). The upstream PR merged on September 30, 2026. Real-account, cross-environment sign-in validation remains a release task.

| Stage | Client model | User-visible outcome |
| --- | --- | --- |
| **Crawl: initial release** | One GitHub.com client plus one selected Enterprise client | Configure multiple Enterprise instances and switch the account/instance used by this extension through VS Code account preferences. |
| **Walk: follow-up** | One selected account/client per host | Work with GitHub.com and multiple Enterprise hosts concurrently in one window. |
| **Run: follow-up** | Multiple accounts/clients per host | Bind different repositories to different accounts, including multiple GitHub.com accounts. |

### Crawl example

```json
{
  "github-enterprise.uris": [
    "https://company.ghe.com",
    "https://github.example.com"
  ]
}
```

If the extension's selected Enterprise account belongs to `company.ghe.com`:

- GitHub.com repositories continue using the separate GitHub.com account.
- Repositories on `company.ghe.com` work.
- Repositories on `github.example.com` are unavailable until the user switches the extension's Enterprise account.
- The UI explains this limitation and how to switch. It must not silently hide the second host as though it had no pull requests.
- Reordering the array does not change the selected account, API destinations, or available repositories.

## Upstream contract to consume

The built-in GitHub Authentication extension owns both settings and the authentication providers. This extension must not redeclare either setting or implement its own authentication provider.

| Effective configuration | Enterprise instances |
| --- | --- |
| Neither setting configured | None |
| Only legacy `github-enterprise.uri = A` | A |
| Explicit `github-enterprise.uris = [B, C]`, with or without legacy A | B and C |
| Explicit `github-enterprise.uris = []`, even with legacy A | None |
| Invalid explicit plural value | Configuration error; do not fall back to legacy A |

Additional upstream guarantees:

- The plural list is unordered. There is no first-host default.
- VS Code configuration precedence still applies within a setting; arrays are not unioned across scopes. Only eligible explicit plural values suppress the legacy setting. A schema default must not suppress it.
- Workspace and folder values apply only in trusted workspaces. An ignored untrusted workspace value, including `[]`, must not override eligible user configuration.
- There is still one `github-enterprise` provider, separate from `github`.
- A returned session's `authorizationServer` identifies its OAuth issuer. It is not a REST endpoint. Enterprise API destinations must come from that session, not from either setting.
- Native session and account IDs are unchanged and can collide across hosts. Do not parse or invent host-prefixed IDs.
- Enterprise account labels include the host, including applicable ports/deployment paths. Labels are presentation, not routing data. The provider label remains `GitHub Enterprise`.
- Existing preferences and native account selection remain authoritative. When creating a session without an account/issuer hint, the provider uses the sole configured instance or its native instance picker.
- Removing a configured instance hides its sessions without deleting saved credentials. Adding it back can restore those sessions.

Sources: upstream [configuration resolution and validation](https://github.com/microsoft/vscode/blob/a3f9a6f0af8ccbe91872208fee714c2c471dc081/extensions/github-authentication/src/common/enterpriseConfiguration.ts), [provider behavior](https://github.com/microsoft/vscode/blob/a3f9a6f0af8ccbe91872208fee714c2c471dc081/extensions/github-authentication/src/githubEnterprise.ts), and [user-facing documentation](https://github.com/microsoft/vscode/blob/a3f9a6f0af8ccbe91872208fee714c2c471dc081/extensions/github-authentication/README.md).

## Baseline used for planning

Much of the routing prerequisite has already landed. Crawl should build on it, not replace it.

| Surface | Already present at the baseline | Required Crawl change |
| --- | --- | --- |
| [CredentialStore](../src/github/credentials.ts) and [authentication utilities](../src/common/authentication.ts) | One client per provider; session-derived server URI; selected-account/issuer scope upgrades; explicit failure for unsupported Enterprise provenance. | Preserve this model and add multi-host configuration regressions. No host-to-client registry. |
| [Enterprise setup helpers](../src/github/utils.ts) | Legacy getter/setter/presence check. Setter writes the singular setting at workspace scope; getter changes HTTP to HTTPS. | Resolve plural precedence, preserve URL identity, and make setup non-destructive. |
| [RepositoriesManager](../src/github/repositoriesManager.ts) | Enterprise setup and sign-in orchestration. | Stop assuming one configured instance or choosing the first discovered remote when several are plausible. |
| [Welcome contributions](../package.json) | Enterprise welcome condition checks `config.github-enterprise.uri`. | Use effective plural/legacy configuration, including empty-list and trust semantics. |
| [Remote matching](../src/common/remote.ts), [GitHubRepository](../src/github/githubRepository.ts), and [FolderRepositoryManager](../src/github/folderRepositoryManager.ts) | Session/remote matching; mismatched Enterprise repositories filtered out; guarded API access; user caches scoped by provider, server, and account. | Preserve the guards and explain configured-but-unselected repositories rather than just filtering them. |
| [Extension session-change handling](../src/extension.ts) | Account/server changes clear account-sensitive views and refresh repositories, reviews, issues, and notifications. | Verify native multi-host events drive this path correctly without reload. |
| [Clone integration](../src/gitExtensionIntegration.ts) | Search/list caches tied to the selected client. | Preserve selected-host-only behavior and verify switching does not reuse old results. |

Existing [issuer integration tests](../src/test/github/authIssuers.test.ts) already cover session-derived REST/GraphQL routing, missing provenance, host/token changes, issuer-pinned upgrades, mismatched repositories, and clone-cache isolation. These are preservation requirements, not new architecture to build.

## Crawl requirements

### 1. Resolve configuration once, consistently

Use shared plural-aware operations in the existing [authentication configuration module](../src/authentication/configuration.ts), replacing the singular helpers in [GitHub utilities](../src/github/utils.ts), with setting keys in [settingKeys.ts](../src/common/settingKeys.ts). Keeping configuration with authentication allows setup, discovery, and UI to share it without putting configuration state in the credential store.

- Inspect explicit values to distinguish an unset plural setting from an explicitly configured empty list.
- Use the same configuration context and trust semantics as the built-in provider. Do not create a union of workspace-folder settings or invent per-repository configuration precedence.
- Return the effective instance list for setup, discovery hints, and UI. Do not cache a second mutable copy of configuration in the credential store.
- Validate URLs consistently with upstream: HTTP/HTTPS Enterprise instance URLs; no credentials, query, fragment, public GitHub endpoints, or malformed deployment paths.
- Preserve scheme, explicit port, and deployment path. In particular, remove the current setup getter's HTTP-to-HTTPS coercion.
- Compare duplicates using upstream-compatible URI identity: normalize scheme/host and trailing slashes without lowercasing deployment paths or collapsing different schemes/ports.
- Invalid explicit configuration must be reported through localized UI and the existing logger, not silently filtered or converted into a legacy/default host. Avoid duplicate notifications for errors the provider already presents.
- Keep deterministic precedence/validation logic independently testable. Do not introduce test-only parameters, a new helper class, or production APIs solely for tests.

### 2. Make setup additive, not a single-host replacement

Update [RepositoriesManager.authenticate](../src/github/repositoriesManager.ts) and the setup helpers:

**When a valid effective list already exists**

- Sign in against `github-enterprise` without rewriting settings or prompting to replace a server URL.
- Let VS Code reuse its selected account or show its native selection UI. Do not pass the first configured URI as an issuer hint.
- Adding another instance is an explicit configuration action, not a side effect of sign-in, repository focus, refresh, or account selection.
- If the sign-in command reuses an existing account, offer **Select Account** to open extension account preferences; do not make ordinary sign-in silently switch hosts.

**When setup is needed or the user explicitly adds an instance**

- A discovered remote may be a suggested URL, not an implicit selection. If multiple distinct candidate instances exist, require a choice or explicit URL rather than taking index zero.
- Write `github-enterprise.uris`, not the deprecated singular key.
- Rely on the 1.141 engine minimum and latest-Insiders expectation. Do not dual-write the settings or choose a writer based on runtime feature detection.
- Read current configuration at write time and preserve all effective instances. Deduplicate equivalent additions.
- When first writing the plural setting over legacy-only configuration, include the effective legacy instance. For example, adding B to legacy A produces `[A, B]`.
- An existing explicit `[]` starts from no instances. Adding B produces `[B]`, not `[legacy A, B]`.
- Preserve the legacy key; do not perform automatic settings cleanup or credential migration.
- Retain the existing workspace-write policy for Crawl. If creating a workspace override of a user list, seed it with the effective list before appending so existing hosts are not dropped. This is an explicit write, not a new cross-scope merge rule.
- If there is no writable trusted workspace, or a more specific setting would shadow the write, direct the user to the relevant settings instead of claiming setup succeeded or silently changing user-level configuration.
- Cancellation or invalid input before saving causes no setting write and starts no authentication. Cancellation of a later authentication picker must not change the selected client; an already-confirmed configuration addition need not be rolled back.
- Configuration-write failures stop the flow and surface an actionable error.

General Enterprise setup must continue accepting GHES as well as GHE.com. The cloud-only restrictions in upstream Copilot enrollment are not restrictions on this extension's ordinary Enterprise setup.

### 3. Distinguish configured, authenticated, and selected

Configuration is not evidence of authentication, and authentication with Enterprise A is not authentication for Enterprise B.

For the welcome view, publish a derived context key such as `github:hasEnterpriseUris` from the effective validated configuration. Initialize it during activation and update it on changes to either setting and on trust grant. Use that key in [package.json](../package.json) instead of checking the legacy setting or relying on array truthiness.

An explicit empty list must not be displayed as configured Enterprise authentication. Existing remote-discovery setup entry points may remain: choosing one explicitly opts back into configuration.

For the PR tree and repository-specific actions, distinguish:

| State | Required presentation |
| --- | --- |
| No configured instance for the target | Offer explicit setup or settings guidance. |
| Configured instance, no selected Enterprise session | Offer **Select Account**, opening the scoped preferences picker or starting sign-in if no Enterprise accounts exist. |
| Session on A, repository on B | Explain the selected-host mismatch and how to switch. Do not offer a misleading "Sign in" loop that just reuses A. |
| Session matches repository | Preserve existing behavior. |

Suggested mismatch text:

> Using {selectedInstance} for GitHub Enterprise.
>
> Select an account for {repositoryInstance} to view its repositories.

Follow this with **Select Account**. Without a selected session, use "Select a GitHub Enterprise account to view repositories on {repositoryInstance}." Display host, port, and deployment path without the URL scheme or trailing slash. Escape interpolated text as Markdown while preserving ordinary, breakable spaces and paragraphs.

Requirements:

- Explain unavailable hosts even in mixed workspaces where GitHub.com or another matching repository keeps the overall repositories manager in its loaded state.
- Show the explanation in the affected folder/repository context, or an aggregated PR-tree message if that folder is currently omitted. Do not display unavailable repositories as an empty successful query.
- When all repositories need authentication, the PR tree is hidden. Show the same guidance in the login view. Offer **Select Account** for configured instances, and a settings action only for missing or invalid configuration.
- Preserve GitHub.com sign-in alongside Enterprise guidance when public repositories need authentication, including when Enterprise configuration is invalid. A non-empty login-view message replaces the contributed welcome actions.
- Derive rendering from repository-owned discovery results. Do not start or await network classification from either view; pending discovery for unrelated or excluded remotes must not block known repositories or sign-in guidance. Refresh guidance when discovery completes even if the authentication state is unchanged.
- A known configured instance can be used as a discovery/diagnostic hint even before it is selected. Do not require a successful unauthenticated server probe merely to explain a configured-host mismatch.
- Keep discovery hints separate from authenticated API routing. Do not classify arbitrary unrelated remotes as configured Enterprise instances.
- Switching account preferences affects all Enterprise repositories in that extension host, not just the repository from which the user opened the guidance.
- Reuse the native Accounts experience. The **Select Account** action checks for accounts only on user invocation, not during rendering. With existing accounts, invoke `_manageAccountPreferencesForExtension` with `GitHub.vscode-pull-request-github` and `github-enterprise`; without accounts, start Enterprise sign-in instead of opening an empty picker. This internal command's two-argument contract was verified against the local VS Code source; retain integration coverage for it.
- Localize new text using the repository's existing mechanisms. No new account-management UI is required.

### 4. Preserve session-authoritative routing and lifecycle

Keep [getSessionGitHubUri](../src/common/authentication.ts) and the client construction in [credentials.ts](../src/github/credentials.ts) authoritative:

- Derive the selected Enterprise instance from `session.authorizationServer` by removing `/login/oauth`.
- Preserve GHES REST/GraphQL deployment paths and the existing GHE.com API-host mapping.
- Never construct a client destination from `uris[0]`, the legacy setting, an account label, or the remote URL paired with a token from some other session.
- Missing or unsupported Enterprise provenance remains an explicit unavailable state. There is no configuration-based routing fallback.
- Keep account and issuer hints on scope upgrades and forced reauthentication. An account ID alone does not distinguish accounts on different hosts.
- Keep background/session refresh passive. An ambiguous silent lookup must not open a picker or make an extension-defined choice.
- Continue guarding repository-bound operations with the actual selected session/remote match, including operations initiated from existing editors, comments, and webviews.
- Preserve existing HTTP-remote path/port matching and SSH transport behavior. An SSH transport port is not an API port. Crawl does not infer a new deployment binding from an ambiguous SSH URL; the selected Enterprise instance remains the authentication context.

On native session or provider lifecycle changes:

- Re-read the selected session and replace or clear the client accordingly.
- Treat an issuer change as a connection change even if session/account IDs are identical.
- Clear account/host-sensitive state through the existing refresh path: repository metadata, PR/issue views, review/comment state, notifications, and user caches.
- Token refresh on the same account/issuer must replace the client without unnecessarily treating it as a different account.
- Adding/removing an unrelated host or reordering the list must not reset an unchanged selected connection.
- Removing the active host, configuring `[]`, or making configuration invalid must not leave its old client usable after the provider reports the change. Adopt only the session returned by VS Code, or become unavailable; never select a replacement from array order.
- Discard stale results from the retired connection rather than publishing them into the new connection's UI/cache. Use existing lifecycle ownership and source-of-truth checks, not new generation counters.
- Do not delete saved sign-ins. Credential storage and migration belong to the authentication provider.

Do not add configuration listeners that directly repoint an existing client's token. Configuration listeners maintain setup/UI; authentication events determine the selected connection.

### 5. Preserve adjacent behavior without expanding its scope

- **GitHub.com:** retain one selected public account/client and existing public environment-token support. Switching Enterprise hosts must not change the GitHub.com account or endpoint.
- **Clone/search:** retain one Enterprise source backed by the selected client, not a search across every configured host.
- **Notifications and hostless tools:** retain their existing provider-selection policy; do not start aggregating all hosts. Ensure old-host results/actions are cleared or rejected when selection changes.
- **Repository-bound tools and agent actions:** preserve repository/selected-session checks; never make an inactive host appear supported merely because it is configured.
- **Copilot:** this work does not expand GHES eligibility, change Copilot API endpoints, or duplicate upstream enrollment. Validate existing selected-account flows only.
- **Web/remote environments:** configuration resolution and selection behavior must work without Node-only helpers. Preserve proposed API availability in each supported distribution.
- **Logging:** use the existing logger, never access-token logging. Do not add hostname/account-label telemetry for this feature.

## Implementation slices

### A. Configuration and setup

Update [settingKeys.ts](../src/common/settingKeys.ts), [authentication configuration](../src/authentication/configuration.ts), and [repositoriesManager.ts](../src/github/repositoriesManager.ts); remove the superseded helpers from [GitHub utilities](../src/github/utils.ts). Cover precedence, validation, write preservation, cancellation, and native sign-in orchestration in [configuration tests](../src/test/authentication/configuration.test.ts) and [repositories manager tests](../src/test/github/repositoriesManager.test.ts).

### B. UI and lifecycle integration

Initialize and maintain the derived configuration context in [repositoriesManager.ts](../src/github/repositoriesManager.ts), update welcome conditions in [package.json](../package.json), and present mismatch guidance in [prsTreeDataProvider.ts](../src/view/prsTreeDataProvider.ts) / [categoryNode.ts](../src/view/treeNodes/categoryNode.ts). Use runtime localization for the new messages; existing localized command contributions remain unchanged. Use [folderRepositoryManager.ts](../src/github/folderRepositoryManager.ts) and [githubServer.ts](../src/authentication/githubServer.ts) for repository availability and discovery information rather than another mutable connection model. Preserve the existing session-change cleanup in [extension.ts](../src/extension.ts).

Reuse the credential store and existing API guards. Change their implementation only where the acceptance tests demonstrate a missing multi-host lifecycle behavior.

### C. Validation and release documentation

Extend [authIssuers.test.ts](../src/test/github/authIssuers.test.ts), [credentials.test.ts](../src/test/github/credentials.test.ts), [remote.test.ts](../src/test/common/remote.test.ts), and [folderRepositoryManager.test.ts](../src/test/github/folderRepositoryManager.test.ts). Add view/setup tests under the existing [test tree](../src/test) as needed.

As part of implementation, bump `engines.vscode` from `^1.140.0` to `^1.141.0` in [package.json](../package.json). Update the user documentation and [release guidance](./releasing.md) to describe that minimum, the latest-Insiders expectation, the plural setting, legacy read fallback, account switching, and the one-active-Enterprise-account limitation. Do not advertise simultaneous multi-host operation.

## Acceptance criteria

Automated tests must exercise product code, stubbing VS Code configuration/authentication and network boundaries rather than implementing a parallel resolver in tests.

| Case | Required result |
| --- | --- |
| Runtime compatibility | Manifest requires `^1.141.0`; stable 1.140 and earlier cannot load this extension release. Setup writes only the plural setting; no compatibility shim for early 1.141 Insiders snapshots. |
| Unset plural, legacy A | A is recognized; no eager migration or setting write. A schema default `[]` does not hide A. |
| Plural `[B, C]` and legacy A | Only B/C are configured. Reordering leaves selection unchanged. |
| Explicit plural `[]` | Legacy A is suppressed at every eligible scope; no client is reconstructed from it. |
| Scope/trust combinations | Ordinary VS Code precedence applies; ignored untrusted workspace/folder values cannot override eligible user settings. Granting trust updates UI and native session availability. |
| Invalid plural value, invalid entry, or invalid URL | Explicit error; no legacy fallback, partial-success host list, setting rewrite, or guessed endpoint. |
| HTTP, ports, deployment paths, equivalent trailing slashes | Preserve distinct identities and deduplicate equivalent additions; no forced HTTPS or path-case folding. |
| Sign-in with `[A, B]` already configured | No setting writes; native preference/picker decides the account. No first-host hint. |
| Add B to legacy A / plural `[A, C]` / explicit `[]` | Produce `[A, B]` / `[A, C, B]` / `[B]` at the supported write target; preserve unrelated settings and the legacy key. |
| Cancel setup, reject invalid input, or fail a write | No authentication starts and no partial configuration change is reported as success. |
| Two available hosts, no unambiguous silent selection | No background prompt or guessed host; explicit sign-in can use the native picker. |
| Selected B while A is also configured | Actual REST and GraphQL requests carry B's token only to B-derived endpoints. Missing issuer metadata fails explicitly. |
| GitHub.com + Enterprise A + Enterprise B workspace, A selected | Public/A repositories work; B is visibly unavailable with switching guidance. Repository actions for B issue no request using A's token. |
| Mixed public/Enterprise repositories, no selected sessions; or public repositories with invalid Enterprise configuration | Public sign-in remains available alongside the Enterprise sign-in/configuration actions that apply. |
| Unrelated or excluded remote discovery is pending | Known repositories and sign-in guidance render without starting another scan or waiting for discovery. Completion refreshes guidance even when authentication state stays the same. |
| Mismatched or missing account preference in a narrow sidebar | Short guidance wraps naturally without non-breaking-space runs, raw escaped menu instructions, or horizontal overflow. **Select Account** opens the scoped Enterprise picker; no-account users can sign in. |
| Switch A to B, including identical native account/session IDs | Old-host UI/cache results cannot reappear; repository access is re-evaluated; clone/search and notifications do not reuse A's data; GitHub.com account remains unchanged. |
| Refresh token or upgrade scopes on B | Stay on B's account/issuer; a canceled upgrade does not move to A. Preserve same-account metadata where already supported. |
| Remove active A / remove inactive B / clear list / re-add A | Native selection drives client replacement/removal; no stale A requests after retirement; unchanged selected clients survive unrelated edits; no saved sign-in deletion. |
| Existing public-only, legacy-single-host, GHE.com, and GHES usage | Existing authentication, endpoint mapping, review/issue flows, and public environment-token behavior remain intact. |

Also perform an end-to-end pass on a VS Code build containing the upstream change, using an isolated profile:

1. Configure a GitHub.com repository and two real Enterprise instances; exercise native account selection and the host-qualified labels.
2. Open repositories from all three, including two with the same owner/repository name. Verify Crawl's availability boundaries and actionable mismatch UI.
3. Switch Enterprise accounts through **Manage Extension Account Preferences...** with a PR editor, comments, notifications, and clone/search results open.
4. Reorder, add, remove, and clear configured instances without reloading. Verify no surprise sign-in prompts and no deletion of saved accounts.
5. Repeat relevant configuration/selection flows in desktop, web, and remote extension hosts; test trusted and untrusted workspaces.

Use the existing extension test runner and build scripts in [package.json](../package.json). Run the focused suites through available test tooling; the current [Mocha runner](../src/test/index.ts) does not expose a documented CLI grep switch, so do not assume `npm test -- --grep` is targeted. The implementation must pass type checking and supported node/web builds; run `npm run lint` and `npm run hygiene` before committing.

## Rollout gates

- Verify the final merged upstream contract, including configuration precedence, session provenance, and native account-preference behavior.
- Require `engines.vscode: "^1.141.0"` in [package.json](../package.json), retaining the existing `authIssuers` declaration. Confirm the plural setting and required lifecycle behavior are included in stable 1.141 before the stable rollout.
- Implementation can land now. The short compatibility gap for early 1.141 Insiders builds is accepted; validate against current Insiders containing the upstream change rather than maintaining compatibility with older Insiders snapshots.
- Confirm proposed API production allowlisting, separately from extension compilation, as described in [releasing.md](./releasing.md).
- Write only the plural setting. Keep legacy configuration read compatibility for users who have not changed their settings; this is independent of runtime-version compatibility. No token-storage migration, mass settings rewrite, new activation event, or new public setting is part of Crawl.
- Publish the one-selected-Enterprise-account limitation and switching instructions with the release.

## Follow-up outlines

### Walk: simultaneous hosts

Replace provider-wide Enterprise selection with host-aware connections, keeping one account per host.

- Request sessions with explicit `authorizationServer` hints for the intended host; verify the returned session before routing. Configuration supplies candidate hosts, never token provenance.
- Make credential lookup, scope state, reauthentication deduplication, current-user state, and invalidation host-specific. Keep GitHub.com separate.
- Select the connection from the repository's host/deployment identity, not just `AuthProvider.githubEnterprise`. Define how ambiguous SSH remotes choose a deployment.
- Update repository discovery, notifications, clone/search, tools, and agent flows deliberately: repository-bound operations use their host; hostless operations need explicit selection or defined aggregation.
- Include host identity in repository/cache/item keys wherever owner/name or native IDs alone currently suffice.
- Add host-specific errors and sign-in actions so one unavailable instance does not block another. Do not prompt for every configured host during activation.
- Prove two Enterprise hosts with colliding IDs and identical owner/repository names can be used concurrently without credential or state crossover.

This is the first phase that requires a multi-client architecture; it should be a separate implementation proposal.

### Run: multiple accounts on one host

Add an explicit repository-to-account selection model for both Enterprise and GitHub.com.

- Identify a connection by provider, issuer, and account, not account ID or label alone.
- Define repository/account binding, persistence scope, account-picker UX, removal behavior, and fallback semantics.
- Revisit scope upgrades, authorization/consent, notifications, reviews, user caches, and hostless actions for multiple accounts on the same host.
- Verify VS Code's account-preference APIs can represent the intended bindings before committing to the UX. Crawl must not pre-empt the upstream structured-account identity work.
- Prove two GitHub.com accounts and two accounts on one Enterprise host can operate concurrently with distinct permissions and no unintended fallback.

Neither follow-up is necessary merely to honor `github-enterprise.uris`.
