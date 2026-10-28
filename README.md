# Azure DevOps Pull Requests

A standalone fork of the GitHub Pull Requests extension that keeps its original UI and
workflows (pull request tree, React overview, creation form, diff viewers, inline comment
controllers, and review mode) and runs them against Azure DevOps through a provider
boundary instead of GitHub. It installs alongside GitHub Pull Requests: the extension ID is
`jhare96.vscode-pull-request-azdo`, and all commands, settings, views, and document schemes
are independently namespaced (`azdo.*`, `azureDevOpsPullRequests.*`).

## Getting started

1. Open a folder whose Git remote is an Azure DevOps repository, for example
   `https://dev.azure.com/<org>/<project>/_git/<repo>`, a legacy `*.visualstudio.com` URL,
   or an `ssh.dev.azure.com` SSH remote.
2. Open the **Azure DevOps** view and choose **Sign in**. Azure DevOps Services supports a
   Microsoft account or a personal access token; Azure DevOps Server uses a personal access
   token. Tokens need **Code (read & write)** and **Project and Team (read)**, and are kept in
   VS Code Secret Storage. **Azure DevOps Pull Requests: Sign out of Azure DevOps** removes them.
3. For Azure DevOps Server, first trust the collection in the user-level
   `azureDevOpsPullRequests.serverCollections` setting, for example
   `https://devops.example.com/tfs/DefaultCollection`. Workspace settings cannot grant this
   trust, and credentials are only sent to trusted collections.

If a Microsoft session cannot be renewed silently, the view shows **Sign in** rather
than continuing to load. Choose **Sign in** again (or use a personal access token).
The Azure view's loading and sign-in state is independent of the GitHub Pull Requests
extension, so both extensions can remain enabled.

## Supported workflows

- **Pull request tree:** Local Pull Request Branches, Waiting For My Review, Created By Me,
  and All Open, with paging. Custom categories in `azureDevOpsPullRequests.queries` support
  `is:open|closed|merged`, `author:`, `review-requested:`, `base:`, `head:`, and the
  current repository's `repo:`. Unsupported qualifiers show an error on the category.
- **Overview:** title/description editing, Markdown rendering, general and inline
  discussions, reviewers and votes, labels, branch policies and status checks, draft and
  ready states, retargeting, abandon, and copy/open-in-browser links. If checks or
  discussions fail to load, the rest of the page still loads and that section shows an
  error with Retry.
- **Changes and checkout:** changed files and diffs between the PR's merge base and its latest
  iteration, commits, viewed-file state (stored locally per source blob), and the original
  checkout, return-to-default-branch, and dirty-working-tree safeguards.
- **Comments and reviews:** single comments, replies, edit/delete, resolve/reactivate, and
  review mode with private drafts kept locally until you submit. Approve maps to
  vote 10, Request Changes to −10, and comment-only submissions do not change your vote.
  Submission is resumable without duplicate comments. Nothing is published or voted if the
  pull request source changed since the review began.
- **Creation:** the original form with Azure branches, draft creation, Azure pull request templates
  (`.azuredevops`, `.vsts`, `docs`, or the repository root), reviewers, labels used in the
  repository, and auto-complete.
- **Completion:** merge, squash, or rebase completion against the reviewed source commit,
  and auto-complete. Complete is only offered when Azure reports the merge is possible and
  blocking policies have passed; if policies cannot be loaded, completion is withheld.
  Remote source branches are deleted only if they still point to the reviewed commit.

## Not supported

Work items (browsing, linking, automatic transitions on completion) are deferred, and
their views are hidden. GitHub-only features are hidden or report an explicit
"not supported for Azure DevOps repositories" error: GitHub issues and notifications,
Copilot coding agent, Codespaces/vscode.dev, merge queues, pull request stacks, projects,
milestones, assignees, file uploads, reactions, attestation commits, reverting merged pull
requests, and creating pull requests from forks.

## Branches

`feat/azure-provider-shared-ui` starts from upstream `b7b9342b`. The earlier separate Azure UI
is preserved on `backup/azure-parallel-ui-20261019` (`ccf1fe3a`). No history was rewritten.

## Development

- F5 runs `npm run compile` before launching.
- `npm run compile` builds the desktop, browser, and original React webview bundles.
- `npm run compile:test` type-checks and emits extension-host tests.
- `npm run test:webviews` runs the original shared UI regression suite.
- `npm run check:commands`, `npm run lint`, and `npm run hygiene` validate contributions
  and repository conventions.

The original project documentation below is retained as **upstream reference** only.
Its GitHub setup instructions do not apply to this extension.

---

## Upstream documentation

> Review and manage your GitHub pull requests and issues directly in VS Code

This extension allows you to review and manage GitHub pull requests and issues in Visual Studio Code. The support includes:

- Authenticating and connecting VS Code to GitHub and GitHub Enterprise.
- Listing and browsing PRs from within VS Code.
- Reviewing PRs from within VS Code with in-editor commenting.
- Validating PRs from within VS Code with easy checkouts.
- Terminal integration that enables UI and CLIs to co-exist.
- Listing and browsing issues from within VS Code.
- Hover cards for "@" mentioned users and for issues.
- Completion suggestions for users and issues.
- A "Start working on issue" action which can create a branch for you.
- Code actions to create issues from "todo" comments.

![PR Demo](.readme/demo.gif)

![Issue Demo](.readme/issueDemo.gif)

# Getting Started

It's easy to get started with GitHub Pull Requests for Visual Studio Code. Simply follow these steps to get started.

1. Install the extension from within VS Code or download it from [the marketplace](https://aka.ms/vscodepr-download).
1. Open your desired GitHub repository in VS Code.
1. A new viewlet will appear on the activity bar which shows a list of pull requests and issues.
1. Use the button on the viewlet to sign in to GitHub.
1. You may need to configure the `githubPullRequests.remotes` setting, by default the extension will look for PRs for `origin` and `upstream`. If you have different remotes, add them to the remotes list.
1. You should be good to go!

Check out https://www.youtube.com/watch?v=LdSwWxVzUpo for additional getting started tips!

# Configuring the extension

There are several settings that can be used to configure the extension.

## GitHub Enterprise

VS Code 1.141 or later is required. If you use Insiders, keep it updated to the latest build.

Configure GHE.com and GitHub Enterprise Server instances using the built-in GitHub Authentication setting:

```json
{
	"github-enterprise.uris": [
		"https://company.ghe.com",
		"https://github.example.com"
	]
}
```

The list order does not select a default instance. An explicitly configured list takes precedence over the deprecated `github-enterprise.uri` setting, including an empty list (`[]`), which disables Enterprise instances. If the list is not configured, the legacy setting still applies. Workspace and folder instance settings only apply in trusted workspaces.

GitHub Pull Requests uses **one selected Enterprise account at a time**, alongside a separate GitHub.com account. When another instance is needed or no account is selected, use **Select Account** in the Pull Requests or Login view. This opens account preferences for this extension and GitHub Enterprise directly, or starts sign-in if you have no Enterprise accounts yet. You can also run **GitHub Pull Requests: Select GitHub Enterprise Account...** or use **Accounts > Manage Extension Account Preferences...**. To add another instance, edit `github-enterprise.uris` in Settings; ordinary sign-in does not replace your existing list.

Removing an instance from the list does not delete its saved sign-ins. GitHub.com accounts do not need either Enterprise setting.

## Remotes and queries

As mentioned above, `githubPullRequests.remotes` is used to specify what remotes the extension should try to fetch pull requests from.

To customize the pull request tree, you can use the `githubPullRequests.queries` setting. This setting is a list of labels and search queries which populate the categories of the tree. By default, these queries are "Waiting For My Review", "Assigned To Me", and "Created By Me". An example of adding a "Mentioned Me" category is to change the setting to the following:

```
"githubPullRequests.queries": [
	{
		"label": "Waiting For My Review",
		"query": "is:open review-requested:${user}"
	},
	{
		"label": "Assigned To Me",
		"query": "is:open assignee:${user}"
	},
	{
		"label": "Created By Me",
		"query": "is:open author:${user}"
	},
	{
		"label": "Mentioned Me",
		"query": "is:open mentions:${user}"
	}
]
```

Similarly, there is a setting to configure your issues queries: `githubIssues.queries`.

Queries use [GitHub search syntax](https://help.github.com/en/articles/understanding-the-search-syntax).

To view additional settings for the extension, you can open VS Code settings and search for "github pull requests".

# Issues

This extension is still in development, so please refer to our [issue tracker for known issues](https://github.com/Microsoft/vscode-pull-request-github/issues), and please contribute with additional information if you encounter an issue yourself.

## Questions? Authentication? GitHub Enterprise?

See our [wiki](https://github.com/Microsoft/vscode-pull-request-github/wiki) for our FAQ.

## Contributing

If you're interested in contributing, or want to explore the source code of this extension yourself, see our [contributing guide](https://github.com/Microsoft/vscode-pull-request-github/wiki/Contributing), which includes:

- [How to Build and Run](https://github.com/Microsoft/vscode-pull-request-github/wiki/Contributing#build-and-run)
- [Architecture](https://github.com/Microsoft/vscode-pull-request-github/wiki/Contributing#architecture)
- [Making Pull Requests](https://github.com/Microsoft/vscode-pull-request-github/wiki/Contributing#pull-requests)
- [Code of Conduct](https://github.com/Microsoft/vscode-pull-request-github/wiki/Contributing#code-of-conduct)
