<h1 align="center">
  <br>
    <img src="https://raw.githubusercontent.com/Microsoft/vscode-pull-request-github/master/resources/icons/github_logo.png" alt="logo" width="200">
  <br>
 GitHub Pull Requests
</h1>

<h4 align="center">Review and manage your GitHub Pull Requests directly in VS Code</h4>

<p align="center">

[![Build Status](https://vscode.visualstudio.com/_apis/public/build/definitions/9a4d7c24-3234-459a-a944-80bbe5a0824c/10/badge)](https://pull-requests-extension.visualstudio.com/VSCodePullRequestGitHub/_build/index?definitionId=1)

</p>

This extension allows you to review and manage GitHub Pull Requests in Visual Studio Code. The support includes:
- Authenticate and connect VS Code to GitHub
- List and browse Pull Requests from within VS Code
- Review PRs from within VS Code with in-editor commenting.
- Validating PRs from within VS Code with easy checkouts.
- Terminal integration that enables UI and CLIs to co-exist.

![Demo](https://github.com/Microsoft/vscode-pull-request-github/blob/master/.readme/demo.gif?raw=true)

# How to get started?
It's easy to get started with Pull Requests for GitHub in VS Code. Simply follow these steps to get started.

1. Install latest VS Code Insiders from [https://code.visualstudio.com/insiders](https://code.visualstudio.com/insiders)
1. Grab the latest VSIX from https://github.com/Microsoft/vscode-pull-request-github/releases/
1. Install the VSIX by running `Extensions: Install from VSIX` from your command palette.
1. Reload VS Code after the installation (click the reload button next to the extension)
1. Open your desired repo
1. Go to the SCM Viewlet, and you should see the `GitHub Pull Request` treeview.
1. A notification should appear asking you to sign in GitHub, follow the directions to authenticate
1. You should be good to go!

# Extension
This extension is still in development, so please refer to our [issue tracker for known issues](https://github.com/Microsoft/vscode-pull-request-github/issues), and please contribute with additional information if you encounter an issue yourself.

### How to run from source?
If you want explore the source code of this extension yourself, it's easy to get started. Simply follow these steps:

1. Clone the repository
2. Run `yarn`
3. Compile in the background
    - Run `yarn run watch`
    - Or you can directly start this task by Command Palette -> Run Build Task
4. F5, launch the extension in latest VS Code Insiders.


### Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.microsoft.com.

When you submit a pull request, a CLA-bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., label, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.
