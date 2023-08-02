# How to release

1. Edit version in [package.json](https://github.com/Microsoft/vscode-pull-request-github/blob/main/package.json)
    - Update version of the extension - this is usually the minor version.
	**Until the marketplace supports semantic versioning, the minor version should always be an event number. Odd numbers are reserved for the pre-release version of the extension.**
    - (If necessary) Update vscode engine version

2. Update [CHANGELOG.md](https://github.com/Microsoft/vscode-pull-request-github/blob/main/CHANGELOG.md)
    - In the **Changes** section, link to issues that were fixed or closed in the last sprint. Use a link to the pull request if there is no issue to reference.
    - In the **Thank You** section, @ mention users who contributed (if there were any).

3. If there are new dependencies that have been added, update [ThirdPartyNotices.txt](https://github.com/microsoft/vscode-pull-request-github/commits/main/ThirdPartyNotices.txt).

4. Create PR with changes to `package.json` and `CHANGELOG.md` (and `ThirdPartyNotices.txt` when necessary)
    - Merge PR once changes are reviewed

5. If the minor version was increased, run the nightly build pipeline to ensure a new pre-release version with the increased version number is released

6. Run the release pipeline with the `publishExtension` variable set to `true`. If needed, set the branch to the appropriate release branch (ex. `release/0.5`).

7. Wait for the release pipeline to finish running.

8. Draft new GitHub release
    - Go to: https://github.com/Microsoft/vscode-pull-request-github/releases
    - Tag should be the same as the extension version (ex. `v0.5.0`)
    - Set release title to the name of the version (ex. `0.5.0`)
    - Copy over contents from CHANGELOG.md
    - Preview release
    - **Publish** release

9. If the nightly pre-release build was disable, re-enable in in https://github.com/microsoft/vscode-pull-request-github/blob/c6f00d59fb99c7807bfb963f55926505bdb723ef/azure-pipeline.nightly.yml
