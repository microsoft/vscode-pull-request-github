---
name: summarize-github-issue-pr-notification
description: Summarizes the content of a GitHub issue, pull request (PR), or notification, providing a concise overview of the main points and key details. ALWAYS use the skill when asked to summarize an issue, PR, or notification.
---

# Summarize Issue

## Purpose

Given a json GitHub issue, PR, or notification, this skill summarizes the content, providing a concise overview of the main points and key details. This skill helps users quickly understand the essence of an issue without having to read through the entire content.

## Usage

To use this skill, provide a JSON representation of a GitHub issue. The skill will extract the relevant information and generate a summary that captures the main points and key details of the issue.

## Tips on How to Summarize an Issue

- Do not output code. When you try to summarize PR changes, summarize in a textual format.
- Output references to other issues and PRs as Markdown links.
- If a comment references for example issue or PR #123, then output either of the following in the summary depending on if it is an issue or a PR:
    - [#123](https://github.com/${owner}/${repo}/issues/123)
    - [#123](https://github.com/${owner}/${repo}/pull/123)
- Comments should be summarized with the author first. Ex:
    - @username: This is a comment that summarizes the main point of the comment.
- If the content contains images in Markdown format (e.g., ![alt text](image-url)), always preserve them in the output exactly as they appear. Images are important visual content and should not be removed or summarized.
- Make sure the summary is at least as short or shorter than the issue or PR with the comments and the patches if there are.