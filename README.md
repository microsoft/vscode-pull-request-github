<h1 align="center">
  <br>
    <img src="https://raw.githubusercontent.com/Microsoft/vscode-pull-request-github/master/resources/icons/github_logo.png" alt="logo" width="200">
  <br> 
 vscode-pull-request-github
</h1>

<h4 align="center">Managing your GitHub Pull Requests directly in VS Code.</h4>

<p align="center">

[![Build Status](https://vscode.visualstudio.com/_apis/public/build/definitions/9a4d7c24-3234-459a-a944-80bbe5a0824c/10/badge)](https://pull-requests-extension.visualstudio.com/VSCodePullRequestGitHub/_build/index?definitionId=1)

</p>

This extension allows users to manage GitHub pull requests in VS Code. The support includes
- Authentication to GitHub
- Listing of PRs
- Reviewing PRs
- Validating PRs

![Demo](https://github.com/Microsoft/vscode-pull-request-github/blob/master/documentation/images/demo.gif?raw=true)

## Getting started
1. Install latest VS Code Insiders
1. Grag the latest VSIX from https://github.com/Microsoft/vscode-pull-request-github/releases/
1. Install the VSIX by running `Extensions: Install from VSIX` from your command palette.
1. Reload VS Code after the installation (click the reload button next to the extension)
1. Exit VS Code.
1. Start VS Code Insiders from command line with flag: `code-insiders --enable-proposed-api Microsoft.vscode-pull-request-github`
1. Set your `"github.accessToken"` in your settings, which you grab from https://github.com/settings/tokens (permission repo, user, write:discussion).
1. Open your desired repo
1. Once set, go to the SCM Viewlet, and you should see the `GitHub Pull Request` treeview.
1. You should be good to go!

## Developing from source
* Clone the repository
* Run `npm install`
* Compile in the background
  * Run `npm run compile`
  * Run `npm run build-preview`
  * Or you can directly start these two tasks by Command Palette -> Run Build Task
* F5, launch the extension in latest VSCode Insiders.

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.microsoft.com.

When you submit a pull request, a CLA-bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., label, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.
