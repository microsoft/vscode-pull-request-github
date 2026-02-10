---
name: show-github-search-result
description: Summarizes the results of a GitHub search query in a human friendly markdown table that is easy to read and understand. ALWAYS use this skill when displaying the results of a GitHub search query.
user-invokable: false
---

# Render GitHub Search Result

## Purpose

To take the results of a GitHub search query, which may include issues or pull requests, and render them in a human-friendly markdown table format. This skill extracts the relevant information from each search result and organizes it in a way that is easy to read and understand, allowing users to quickly grasp the key details of each issue or pull request without having to parse through raw data.

## Usage

To use this skill, pass raw search results from a GitHub search query. The skill will then process the data and generate a markdown table that summarizes the key information for each issue or pull request, such as the title, author, labels, state, and any other relevant details. This makes it easier for users to review and analyze the search results at a glance.

## How to Render GitHub Search Results

- If you have the original query, use that to help determine the most important fields to include in the table. Ex:
    - If the query included a specific label, make sure to not include that label in the table as all results will have it.
    - If the query included "is:pr", then focus on fields relevant to pull requests such as "review status" and "merge status".
    - Include a column related to the sort value, if given.
    - Don't include columns that will all have the same value for all the resulting issues.
- Always include a column for the number and title of the item. Format the number as a markdown link to the issue or PR. Ex: [#123](https://github.com/owner/repo/issues/123)