# How to release

1. Edit version in [package.json](https://github.com/Microsoft/vscode-pull-request-github/blob/master/package.json)
  - Update vscode engine version
  - Update version of the extension - this is usually the minor version. The version should be bumped anytime the engine version is bumped


2. Update [CHANGELOG.md](https://github.com/Microsoft/vscode-pull-request-github/blob/master/CHANGELOG.md)
  - Link to issues that were fixed or closed
  - @ mention users who contributed


3. Create PR with changes to `package.json` and `CHANGELOG.md`
  - Merge PR once changes look good


4. Generate VSIX
  - Run `vsce package --yarn`. This will generate a .vsix


5. Draft new GitHub release
  - Go to: https://github.com/Microsoft/vscode-pull-request-github/releases
  - Tag should be the same as the extension version (ex. `v0.5.0`)
  - Set release title to the name of the version
  - Copy over contents from CHANGELOG
  - Upload .vsix
  - **Publish** release


6. Publish extension on marketplace
  - Go to: https://marketplace.visualstudio.com/manage/publishers/github
  - Find `GitHub Pull Requests`
  - Select **Update**
