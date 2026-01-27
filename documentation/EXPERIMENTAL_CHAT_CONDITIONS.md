# Experimental Chat Conditions

## Overview

This document describes the experimental chat feature gating in the GitHub Pull Requests extension for VS Code.

## Feature Gate

The chat session menu items and commands are controlled by the `githubPullRequests.experimental.chat` configuration setting.

## Configuration

To enable the experimental chat feature, set the following in your VS Code settings:

```json
{
  "githubPullRequests.experimental.chat": true
}
```

## Affected Menu Items

When `githubPullRequests.experimental.chat` is `false`, the following menu items and commands are hidden:

### Chat Session Menus (chat/chatSessions)
- **pr.openChanges** - Opens pull request changes in the chat context
- **pr.checkoutChatSessionPullRequest** - Checks out a pull request from a chat session

### Chat Input Session Toolbar (chat/input/editing/sessionToolbar)
- **pr.checkoutFromDescription** - Checks out a pull request from the chat session description
- **pr.applyChangesFromDescription** - Applies changes from the chat session description

## Implementation Details

### When Condition

All chat session menu items include the following `when` condition:

```
chatSessionType == copilot-cloud-agent && config.githubPullRequests.experimental.chat
```

This ensures that:
1. The menu item is only shown for Copilot Cloud Agent chat sessions
2. The experimental chat feature must be enabled

### Alignment with Other AI Features

This implementation aligns with how other AI features are gated in the extension:
- chatParticipants - Gated by specific configuration conditions
- languageModelTools - Gated by language model availability and configuration

## Usage

Once enabled, users will see the chat session menu items and can use the following features:

1. **Open Changes** - View pull request changes directly in the chat interface
2. **Checkout PR** - Switch to a pull request branch from chat suggestions
3. **Apply Changes** - Apply suggested changes from the chat to the workspace

## Testing

To test the experimental chat feature:

1. Enable the setting: githubPullRequests.experimental.chat: true
2. Open a chat session with Copilot Cloud Agent
3. Verify that the chat session menu items are visible
4. Disable the setting: githubPullRequests.experimental.chat: false
5. Verify that the chat session menu items are hidden

## See Also

- Issue #8376 - Chat sessions visible with disableAIFeature
- VS Code Chat API Documentation
