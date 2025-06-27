# Enhanced Authentication Features

This document describes the enhanced authentication features added to the VS Code GitHub Pull Request extension, including verification code handling, session timeouts, and resend mechanisms.

## Overview

The enhanced authentication system provides 2FA-like capabilities by adding:

1. **Verification Code Management**: Generate and validate time-limited verification codes
2. **Session Timeout Handling**: Automatic session expiration with configurable timeouts  
3. **Retry Mechanisms**: Limited attempts with resend capabilities
4. **Event-Driven Architecture**: Events for verification code generation and session timeouts

## Core Components

### VerificationCodeManager

A utility class for managing verification codes with expiration and attempt limiting.

```typescript
import { VerificationCodeManager } from '../common/utils';

// Generate a verification code
const code = VerificationCodeManager.generateVerificationCode({
  expirationMinutes: 10,  // Code expires in 10 minutes
  maxAttempts: 3,         // Allow 3 validation attempts
  codeLength: 6           // 6-digit numeric code
});

// Validate the code
const result = VerificationCodeManager.validateCode(code, userInput);
if (result.isValid) {
  // Code is correct
} else if (result.canRetry) {
  // Code is wrong but user can try again
} else {
  // Code expired or max attempts exceeded
}
```

### Enhanced CredentialStore

The `CredentialStore` class now includes verification code and session management:

```typescript
// Generate verification code for a session
const sessionId = 'session-123';
const verificationCode = credentialStore.generateVerificationCode(sessionId, {
  expirationMinutes: 5,
  maxAttempts: 3
});

// Validate user input
const isValid = credentialStore.validateVerificationCode(sessionId, userInputCode);

// Setup session timeout
credentialStore.setupSessionTimeout(sessionId, AuthProvider.github, 60); // 60 minutes

// Login with verification requirement
const github = await credentialStore.loginWithVerification(
  AuthProvider.github, 
  true, // require verification
  { expirationMinutes: 10 }
);
```

## Event Handling

Listen for verification and timeout events:

```typescript
// Listen for verification code generation
credentialStore.onVerificationCodeGenerated(({ sessionId, code }) => {
  // Show verification code to user or send via email/SMS
  console.log(`Verification code for ${sessionId}: ${code.code}`);
  console.log(`Expires in ${VerificationCodeManager.getRemainingTime(code)} minutes`);
});

// Listen for session timeouts
credentialStore.onSessionTimeout(({ sessionId, authProvider }) => {
  // Handle session timeout
  console.log(`Session ${sessionId} timed out`);
});
```

## Usage Scenarios

### 1. Basic Verification Code Flow

```typescript
// 1. Generate verification code
const sessionId = 'user-auth-session';
const code = credentialStore.generateVerificationCode(sessionId);

// 2. User enters code
const userInput = '123456';
const validation = credentialStore.validateVerificationCode(sessionId, userInput);

if (validation.isValid) {
  // Proceed with authenticated session
} else if (validation.canRetry) {
  // Show error, allow retry
} else {
  // Generate new code or fail authentication
}
```

### 2. Resend Verification Code

```typescript
// Check if resend is allowed
const newCode = credentialStore.resendVerificationCode(sessionId);
if (newCode) {
  // New code generated and sent
} else {
  // Previous code still valid, cannot resend yet
}
```

### 3. Session Timeout Management

```typescript
// Setup timeout when user logs in
const sessionId = await credentialStore.login(AuthProvider.github);
if (sessionId) {
  credentialStore.setupSessionTimeout(sessionId, AuthProvider.github, 30); // 30 min timeout
}

// Clear timeout when user logs out
credentialStore.clearSessionTimeout(sessionId);
```

## Security Considerations

1. **Code Generation**: Uses cryptographically secure random number generation
2. **Time-Limited**: All codes have configurable expiration times
3. **Attempt Limiting**: Prevents brute force attacks with limited attempts
4. **Session Management**: Automatic cleanup of expired sessions and codes
5. **Event-Driven**: Allows for audit logging and monitoring

## Configuration Options

### Verification Code Options
- `expirationMinutes`: How long the code remains valid (default: 10 minutes)
- `maxAttempts`: Maximum validation attempts (default: 3)
- `codeLength`: Length of generated code (default: 6 digits)

### Session Timeout
- Default session timeout: 60 minutes
- Configurable per session
- Automatic cleanup on timeout

## Implementation Notes

- All verification codes are stored in memory and cleared on disposal
- Session timeouts use Node.js setTimeout for precise timing
- Events are emitted for integration with UI components
- TypeScript interfaces provide type safety
- Compatible with existing VS Code authentication APIs