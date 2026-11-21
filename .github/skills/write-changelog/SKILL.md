---
name: write-changelog
description: 'Write a CHANGELOG.md entry for a new extension release. Use when: writing changelog, updating changelog, adding release notes, preparing a release, documenting milestone changes. Requires a milestone name and extension version number.'
argument-hint: 'Provide the extension version (e.g. 0.134.0) and the GitHub milestone name (e.g. 1.112.0)'
---

# Write Changelog Entry

Generate a new entry in `CHANGELOG.md` for an extension release by gathering closed issues and merged PRs from a GitHub milestone.

## Inputs

The user must provide:
1. **Extension version number** - the version for the changelog heading (e.g. `0.134.0`)
2. **GitHub milestone name** - the milestone to query (e.g. `1.112.0`)

## Procedure

### 1. Gather Milestone Items

Search for all closed items in the milestone scoped to `microsoft/vscode-pull-request-github`:

- **Issues (bugs/features):** Search for closed issues with `milestone:"<name>" repo:microsoft/vscode-pull-request-github is:closed`
- **Merged PRs:** Search for merged PRs with `milestone:"<name>" repo:microsoft/vscode-pull-request-github is:pr is:merged`

### 2. Classify Items

Sort every item into one of these buckets:

| Bucket | Criteria |
|--------|----------|
| **Changes** | Feature requests, enhancements, new settings, new commands, infrastructure improvements (e.g. dependency upgrades, build system changes) |
| **Fixes** | Items labeled `bug`, or PRs that fix a specific issue |
| **Thank You** | Merged PRs authored by external contributors (user type is not `Bot`, and user is not a GitHub staff / `site_admin`) |
| **Skip** | Version-bump PRs (title is just a version like "0.132.0"), test plan items, items from other repos |

### 3. Write the Entry

Insert the new section **at the top** of `CHANGELOG.md`, directly after the `# Changelog` heading and before the previous release section.

Follow this format exactly:

```markdown
## <version>

### Changes

- Description of change one.
- Description of change two with setting `"settingName"`.

### Fixes

- Short description of bug. https://github.com/microsoft/vscode-pull-request-github/issues/<number>
- Another bug fix. https://github.com/microsoft/vscode-pull-request-github/issues/<number>

**_Thank You_**

* [@username (Display Name)](https://github.com/username): Short description of contribution [PR #1234](https://github.com/microsoft/vscode-pull-request-github/pull/1234)
```

### Format Rules

- **Changes:** Write a concise, user-facing description. Do NOT link to issues. Use backticks for setting names and commands. Each entry is a single `- ` bullet.
- **Fixes:** Use the issue title (cleaned up for readability) followed by a space and the full issue URL. Each entry is a single `- ` bullet. If a fix came from a PR without a linked issue, describe it without a URL.
- **Thank You:** Use `* ` bullets (not `- `). Format: `[@login (Name)](profile-url): Description [PR #number](pr-url)`. Only include for external community contributors.
- **Sections:** Omit any section (`### Changes`, `### Fixes`, `**_Thank You_**`) if there are no items for it.
- **No blank lines** between bullets within a section.
- **One blank line** between sections.

### 4. Validate

- Confirm the new section is positioned correctly (after `# Changelog`, before the previous version).
- Verify all issue/PR links are correct and point to `microsoft/vscode-pull-request-github`.
- Ensure no duplicate entries.
