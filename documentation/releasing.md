# How to release

1. Edit version in [package.json](https://github.com/Microsoft/vscode-pull-request-github/blob/master/package.json)
  - Update vscode engine version
  - Update version of the extension - this is usually the minor version. The version should be bumped anytime the engine version is bumped.


2. Update [CHANGELOG.md](https://github.com/Microsoft/vscode-pull-request-github/blob/master/CHANGELOG.md)
  - In the **Changes** section, link to issues that were fixed or closed in the last sprint. Use a link to the pull request if there is no issue to reference.
  - In the **Thank You** section, @ mention users who contributed (if there were any).


3. Create PR with changes to `package.json` and `CHANGELOG.md`
  - Merge PR once changes are reviewed


4. Generate VSIX
  - If you don't yet have  **vsce** install it `npm install -g vsce`
  - Run `vsce package --yarn`. This will generate a .vsix in the project directory.


5. Draft new GitHub release
  - Go to: https://github.com/Microsoft/vscode-pull-request-github/releases
  - Tag should be the same as the extension version (ex. `v0.5.0`)
  - Set release title to the name of the version (ex. `0.5.0`)
  - Copy over contents from CHANGELOG.md
  - Upload .vsix
  - Preview release
  - **Publish** release


6. Publish extension on marketplace
  - Go to: https://marketplace.visualstudio.com/manage/publishers/github
  - Find `GitHub Pull Requests`
  - Select **...** and then **Update** and upload the .vsix you just generated
