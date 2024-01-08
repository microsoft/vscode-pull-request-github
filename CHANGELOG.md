# Changelog

## 0.2.2
- Reintroduced PAT token.
- Fixed [#63](https://github.com/ankitbko/vscode-pull-request-azdo/issues/63)

## 0.2.1
- Fixed continuous popup for authentication.

## 0.2.0
- Fixed [#68](https://github.com/ankitbko/vscode-pull-request-azdo/issues/68) - Changed the authentication mechanism from PAT to OAuth using vscode provided authentication session. This will require users to re-authenticate.

## 0.0.25

- Removed explicit check of azdo url to resolve [#55](https://github.com/ankitbko/vscode-pull-request-azdo/issues/55)

## 0.0.24

- Fixed [#50](https://github.com/ankitbko/vscode-pull-request-azdo/issues/50) - Comments duplicate in review mode
- Fixed [#51](https://github.com/ankitbko/vscode-pull-request-azdo/issues/51) - Comments appear on wrong side in review mode
- Fixed [#52](https://github.com/ankitbko/vscode-pull-request-azdo/issues/52) - Comments when deleted from server does not disappear completely
- Added workplace trust setting
- Git extension activation is now forced before activation of this extension

## 0.0.23

- Fixed [#45](https://github.com/ankitbko/vscode-pull-request-azdo/issues/45) - Seeing duplicate review comments.

## 0.0.22

- Added support for marking files as reviewed [ankitbko/vscode-pull-request-azdo#7](https://github.com/ankitbko/vscode-pull-request-azdo/issues/7)

## 0.0.21

### Changes

- Fixed [ankitbko/vscode-pull-request-azdo#37](https://github.com/ankitbko/vscode-pull-request-azdo/issues/37)

## 0.0.20

### Changes

- Suggest Edit not works.
- Edits can now be applied from PR Description page. Read more in the [wiki](https://github.com/ankitbko/vscode-pull-request-azdo/wiki/Suggest-Edit).

## 0.0.19

### Changes

- Fixed a bug where new thread couldn't be created on left side files.
- Reworked build system

## 0.0.18

### Changes

- Fix [ankitbko/vscode-pull-request-azdo#29](https://github.com/ankitbko/vscode-pull-request-azdo/issues/29)

## 0.0.17

### Changes

- Functionality to add and remove reviewers from PR.

## 0.0.16

### Changes

- visualstudio domain remotes should now resolve. Fixes [ankitbko/vscode-pull-request-azdo#25](https://github.com/ankitbko/vscode-pull-request-azdo/issues/25)

## 0.0.15

### Changes

- Improved logging.

## 0.0.14

### Changes

- Mardown rendering in PR Description panel.

## 0.0.13

### Changes

- Work Item integration with PR. **The PAT token now requires `vso.work_write` permission**.

## 0.0.12

### Changes

- Fixed bug [ankitbko/vscode-pull-request-azdo#18](https://github.com/ankitbko/vscode-pull-request-azdo/issues/18)

## 0.0.11

### Changes

- Proposed API flag is disabled.
- **Released to VS Code Stable.**

## 0.0.10

### Changes

- Diff options now properly work.
- Changed default diff option to merge-base.

## 0.0.9

### Changes

- Status shows properly in Dashboard
- Added system text to timeline view
- Adapted to Secrets API changes in vscode

## 0.0.8

### Changes

- Fixed [ankitbko/vscode-pull-request-azdo#8](https://github.com/ankitbko/vscode-pull-request-azdo/issues/8)
- Tests now work

## 0.0.7

### Changes

- Fixed overflow in batches calculation while getting files in PR

## 0.0.6

### Changes

- Disabled resolveRemote to fix [ankitbko/vscode-pull-request-azdo#5](https://github.com/ankitbko/vscode-pull-request-azdo/issues/5)
- Added key check on secretStore onDidChange.

## 0.0.5

### Changes

- Specified allowCrossOriginAuthentication as true as attempt to fix fix [ankitbko/vscode-pull-request-azdo#4](https://github.com/ankitbko/vscode-pull-request-azdo/issues/4)

## 0.0.4

### Changes

- Added ssh.dev.azure.com to list of valid hosts - Fixes [ankitbko/vscode-pull-request-azdo#3](https://github.com/ankitbko/vscode-pull-request-azdo/issues/3)

## 0.0.3

### Changes

- Changed URI Scheme
- Backported #2538 from upstream

## 0.0.2

### Changes

- Changed command names and view names to make it globally unique.

## 0.0.1

### Changes

First release with following features -

- Authenticating and connecting VS Code to Azure Devops.
- Listing and browsing PRs from within VS Code.
- Reviewing PRs from within VS Code with in-editor commenting.
- Validating PRs from within VS Code with easy checkouts.
