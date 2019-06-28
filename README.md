[![Build Status](https://rebornix.visualstudio.com/Pull%20Request/_apis/build/status/Pull%20Request%20Build?branchName=master)](https://rebornix.visualstudio.com/Pull%20Request/_build/latest?definitionId=5&branchName=master)

> Review and manage your GitHub pull requests directly in VS Code

This extension allows you to review and manage GitHub pull requests in Visual Studio Code. The support includes:
- Authenticating and connecting VS Code to GitHub.
- Listing and browsing PRs from within VS Code.
- Reviewing PRs from within VS Code with in-editor commenting.
- Validating PRs from within VS Code with easy checkouts.
- Terminal integration that enables UI and CLIs to co-exist.

![Demo](.readme/demo.gif)

# Getting Started
It's easy to get started with GitHub Pull Requests for Visual Studio Code. Simply follow these steps to get started.

1. Make sure you have VSCode version 1.27.0 or higher.
1. Download the extension from [the marketplace](https://aka.ms/vscodepr-download).
1. Reload VS Code after the installation (click the reload button next to the extension).
1. Open your desired GitHub repository.
1. If you're using version 0.5.0 of the extension or higher, a new viewlet should be added to the bottom of the activity bar. For older versions, the `GitHub Pull Requests` treeview will appear in the SCM Viewlet.
1. You may need to configure the `githubPullRequests.remotes` setting, by default the extension will look for PRs for `origin` and `upstream`. If you have different remotes, add them to the remotes list.
1. A notification should appear asking you to sign in to GitHub; follow the directions to authenticate.
1. You should be good to go!

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
