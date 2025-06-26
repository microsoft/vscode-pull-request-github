# Manual Testing Guide for PR Checkout Modal Dialog

## Testing the Modal Dialog Implementation

To manually test the uncommitted changes modal dialog for `pr.pick` command:

### Prerequisites
1. Have a Git repository with GitHub remote
2. Have VS Code with GitHub Pull Requests extension
3. Have at least one pull request available to checkout

### Test Cases

#### Test Case 1: No Uncommitted Changes
1. Ensure working directory is clean (no uncommitted changes)
2. Use `pr.pick` command to checkout a different PR
3. **Expected**: Should proceed directly to checkout without showing modal

#### Test Case 2: Working Tree Changes Only
1. Create uncommitted changes (modify/add/delete files without staging)
2. Use `pr.pick` command to checkout a different PR
3. **Expected**: Modal dialog appears with message "You have uncommitted changes that would be overwritten by checking out this pull request."
4. **Options available**: "Stage changes", "Discard changes", "Cancel"

#### Test Case 3: Index Changes Only
1. Stage some changes (`git add`)
2. Use `pr.pick` command to checkout a different PR
3. **Expected**: Modal dialog appears (same as above)

#### Test Case 4: Both Working Tree and Index Changes
1. Have both staged and unstaged changes
2. Use `pr.pick` command to checkout a different PR
3. **Expected**: Modal dialog appears

### Testing Each Option

#### Stage Changes Option
1. Choose "Stage changes" in modal
2. **Expected**: All changes (working tree + index) are staged, then checkout proceeds
3. **Verify**: `git status` should show changes as staged

#### Discard Changes Option
1. Choose "Discard changes" in modal
2. **Expected**: Working tree changes are discarded, then checkout proceeds
3. **Verify**: `git status` should show clean working directory

#### Cancel Option
1. Choose "Cancel" in modal
2. **Expected**: No changes made, PR checkout is cancelled
3. **Verify**: Still on original branch with original changes

#### ESC/Close Modal
1. Press ESC or close modal without choosing
2. **Expected**: Same as "Cancel" - no changes made

### Error Handling
1. Test with repository permissions issues
2. Test with git command failures
3. **Expected**: User-friendly error messages displayed

### Integration with Existing Flow
1. Test that normal PR checkout flow still works when no changes exist
2. Test that existing error handling in ReviewManager.switch still functions
3. **Expected**: No regressions in normal operation

## Code Changes Made

- Added `handleUncommittedChanges()` helper function in `src/commands.ts`
- Integrated check before `ReviewManager.switch()` call in `pr.pick` command
- Added appropriate localization using `vscode.l10n.t()`
- Follows existing modal dialog patterns from `copilotRemoteAgent.ts`