# Manual Testing Guide for Ctrl/Cmd+Click Second Editor Group Feature

## Overview
This feature allows users to open PR changes and session logs in the second editor group by holding Ctrl (Windows/Linux) or Cmd (macOS) while clicking the respective buttons.

## Test Cases

### 1. Open Changes Button
**Location**: PR Detail Webview Header
**Button**: "Open Changes"

**Test Steps**:
1. Open a Pull Request with file changes
2. Regular click on "Open Changes" button
   - **Expected**: Multi-diff view opens in current/active editor group
3. Ctrl/Cmd+click on "Open Changes" button
   - **Expected**: Multi-diff view opens in second editor group

**Verification**:
- Check that editor splits automatically if no second group exists
- Verify the multi-diff view appears in the second editor group
- Confirm tooltip shows "(Ctrl/Cmd+Click to open in second editor group)"

### 2. View Session Log Button
**Location**: PR Timeline (Copilot events)
**Button**: "View session" or error message links

**Test Steps**:
1. Open a Pull Request with Copilot session events
2. Find a "View session" button in the timeline
3. Regular click on "View session" button
   - **Expected**: Session log opens in current/active editor group
4. Ctrl/Cmd+click on "View session" button
   - **Expected**: Session log opens in second editor group

**Verification**:
- Check that webview opens in the correct editor group
- Verify the session log content loads properly
- Confirm tooltip shows "(Ctrl/Cmd+Click to open in second editor group)"

### 3. Session Error Links
**Location**: PR Timeline (Copilot error events)
**Link**: "Copilot has encountered an error. See logs for additional details."

**Test Steps**:
1. Find a Copilot error event in the timeline
2. Regular click on the error link
   - **Expected**: Session log opens in current/active editor group
3. Ctrl/Cmd+click on the error link
   - **Expected**: Session log opens in second editor group

## Implementation Details

### Frontend Changes
- `webviews/components/header.tsx`: Added click handler for Open Changes button
- `webviews/components/timeline.tsx`: Added click handlers for session log buttons
- `webviews/common/context.tsx`: Updated methods to accept `inSecondEditorGroup` parameter

### Backend Changes
- `src/github/pullRequestOverview.ts`: Updated message handlers
- `src/github/pullRequestModel.ts`: Enhanced `openChanges()` with editor group splitting
- `src/view/sessionLogView.ts`: Enhanced `openForPull()` and `open()` with ViewColumn.Two support

### Browser Support
- Uses standard React mouse event properties: `e.ctrlKey` and `e.metaKey`
- Cross-platform: Ctrl on Windows/Linux, Cmd on macOS