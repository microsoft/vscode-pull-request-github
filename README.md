# Review and manage your Azure Devops pull requests directly in VS Code

> This extension is in early stages of development.

This extension is inspired and based on [Github Pull Request Extension for VS Code](https://github.com/Microsoft/vscode-pull-request-github). Currently the extension supports following feature -

- Authenticating and connecting VS Code to Azure Devops.
- Listing and browsing PRs from within VS Code.
- Reviewing PRs from within VS Code with in-editor commenting.
- Validating PRs from within VS Code with easy checkouts.

![PR Demo](.readme/demo.gif)

![Issue Demo](.readme/issueDemo.gif)

# Getting Started
It's easy to get started with GitHub Pull Requests for Visual Studio Code. Simply follow these steps to get started.

1. Make sure you have VSCode version 1.52.0 or higher.
1. Reload VS Code after the installation (click the reload button next to the extension).
1. Open your desired Azure Devops repository.
1. You will need to configure the `azdoPullRequests.projectName` and `azdoPullRequests.orgUrl` setting. You can configure it in workspace settings and commit it so others in your team wouldn't need to do this configuration again.
1. You will need to configure [PAT token in Azure Devops](https://docs.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops&tabs=preview-page) to login. Click on *show all scopes* and select the following scopes for the token - `Code: Read & Write`, `Pull Request Threads: Read & Write`.
1. A new tab would have appeared on the activity bar on the left. Open it and click on `Sign in` button. Enter the PAT token and press enter.
1. You should be good to go!

# Configuring the extension
TODO
## Questions? Authentication? GitHub Enterprise?

See our [wiki](https://github.com/Microsoft/vscode-pull-request-github/wiki) for our FAQ.

## Contributing

TODO
