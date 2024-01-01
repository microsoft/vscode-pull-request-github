# How to release

1. Edit version in [package.json](https://github.com/Microsoft/vscode-pull-request-github/blob/main/package.json)
    - Update version of the extension - this is usually the minor version.
	**Until the marketplace supports semantic versioning, the minor version should always be an event number. Odd numbers are reserved for the pre-release version of the extension.**
    - (If necessary) Update vscode engine version

2. Update [CHANGELOG.md](https://github.com/Microsoft/vscode-pull-request-github/blob/main/CHANGELOG.md)
    - In the **Changes** section, link to issues that were fixed or closed in the last sprint. Use a link to the pull request if there is no issue to reference.
    - In the **Thank You** section, @ mention users who contributed (if there were any).

3. Create PR with changes to `package.json` and `CHANGELOG.md` (`ThirdPartyNotices.txt` changes are not necessary as the pipeline creates the file)
    - Merge PR once changes are reviewed

4. If the minor version was increased, run the nightly build pipeline to ensure a new pre-release version with the increased version number is released

5. Run the release pipeline with the `publishExtension` variable set to `true`. If needed, set the branch to the appropriate release branch (ex. `release/0.5`).

6. Wait for the release pipeline to finish running.

7. Draft new GitHub release
    - Go to: https://github.com/Microsoft/vscode-pull-request-github/releases
    - Tag should be the same as the extension version (ex. `v0.5.0`)
    - Set release title to the name of the version (ex. `0.5.0`)
    - Copy over contents from CHANGELOG.md
    - Preview release
    - **Publish** release

8. If the nightly pre-release build was disable, re-enable in in https://github.com/microsoft/vscode-pull-request-github/blob/c6f00d59fb99c7807bfb963f55926505bdb723ef/azure-pipeline.nightly.yml
