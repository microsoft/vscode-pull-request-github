<h1 align="center">
  <br>
    <img src="https://raw.githubusercontent.com/Microsoft/vscode-pull-request-github/master/resources/icons/github_logo.png" alt="logo" width="200">
  <br>
 GitHub Pull Requests
</h1>

<h4 align="center">Review and manage your GitHub pull requests directly in VS Code</h4>

<p align="center"><a href="https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github"><img src="https://vsmarketplacebadge.apphb.com/version/GitHub.vscode-pull-request-github.svg?label=GitHub%20Pull%20Requests&colorB=196EC5" alt="Marketplace bagde"></a> <a href="https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github#review-details"><img src="https://img.shields.io/vscode-marketplace/r/GitHub.vscode-pull-request-github.svg?label=Ratings&colorB=063063" alt="Marketplace Rating"></a></p>

This extension allows you to review and manage GitHub pull requests in Visual Studio Code. The support includes:
- Authenticate and connect VS Code to GitHub
- List and browse PRs from within VS Code
- Review PRs from within VS Code with in-editor commenting.
- Validating PRs from within VS Code with easy checkouts.
- Terminal integration that enables UI and CLIs to co-exist.

![Demo](https://github.com/Microsoft/vscode-pull-request-github/blob/master/.readme/demo.gif?raw=true)

# How to get started?
It's easy to get started with GitHub Pull Requests for Visual Studio Code. Simply follow these steps to get started.

1. Make sure you have VSCode version 1.27.0 or higher
1. Download the extension from [the marketplace](https://aka.ms/vscodepr-download)
1. Reload VS Code after the installation (click the reload button next to the extension)
1. Open your desired GitHub repo
1. Go to the SCM Viewlet, and you should see the `GitHub Pull Requests` treeview. On the first load, it will appear collapsed at the bottom of the viewlet.
1. A notification should appear asking you to sign in to GitHub; follow the directions to authenticate
1. You should be good to go!

# Extension
This extension is still in development, so please refer to our [issue tracker for known issues](https://github.com/Microsoft/vscode-pull-request-github/issues), and please contribute with additional information if you encounter an issue yourself.

## Questions? Authentication? GitHub Enterprise?

See our [wiki](https://github.com/Microsoft/vscode-pull-request-github/wiki) for our FAQ.

### How to run from source, test and dogfood?
If you want explore the source code of this extension yourself, it's easy to get started. Simply follow these steps:

1. Clone the repository
2. Run `yarn`
3. Compile in the background
    - Run `yarn watch`
    - Or you can directly start this task by Command Palette -> Run Build Task
4. F5, launch the extension in latest VS Code Insiders.

For more information about testing the extension and dogfood, please read [Wiki/Contributing](https://github.com/Microsoft/vscode-pull-request-github/wiki/Contributing)

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
