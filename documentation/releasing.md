# How to release

## Authentication API dependency

Enterprise API destinations use the selected session's `authorizationServer`,
with `/login/oauth` removed, rather than either Enterprise configuration setting.
This requires the **proposed** `authIssuers` API from
[microsoft/vscode#337846](https://github.com/microsoft/vscode/pull/337846),
merged at `2f84f5b38264788d80a9399413cc47cb2a17db51` on the 1.140 development line.
The engine floor is now **1.141.0** for the plural `github-enterprise.uris`
setting and provider lifecycle from
[microsoft/vscode#338080](https://github.com/microsoft/vscode/pull/338080).
Insiders users are expected to use the latest build; the brief compatibility
gap in early 1.141 Insiders snapshots is accepted, without a runtime version
check or legacy-setting write fallback. Confirm stable 1.141 contains the
upstream change before stable rollout. Production
allowlisting is a separate [vscode-distro](https://github.com/microsoft/vscode-distro)
change. Missing enterprise metadata is explicitly unavailable, without a
configuration fallback. Public GitHub/PAT authentication does not require it.

Setup writes only `github-enterprise.uris`. Legacy `github-enterprise.uri` is
still read when no eligible plural value is configured; explicit `[]` disables
Enterprise instances. This extension continues to use one selected Enterprise
account/client at a time, separate from GitHub.com. Release messaging must
explain the **Select Account** action, which opens this extension's GitHub
Enterprise account preferences (or starts first-time sign-in), not advertise
simultaneous multi-host operation. The scoped picker uses VS Code's
`_manageAccountPreferencesForExtension` command with the extension ID and
`github-enterprise` provider ID; include that path in release validation.

## Release steps

1. Edit version in [package.json](https://github.com/Microsoft/vscode-pull-request-github/blob/main/package.json)
    - Update version of the extension - this is usually the minor version.
	**Until the marketplace supports semantic versioning, the minor version should always be an event number. Odd numbers are reserved for the pre-release version of the extension.**
    - Run `npm install` to update `package-lock.json`
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
