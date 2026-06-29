/**
 * Known UI patterns from beta.koyal.ai discovery.
 * Refs (@eN) change every page load — use case-insensitive patterns because
 * agent-browser 0.31+ snapshots often use UPPERCASE labels (e.g. "EMAIL*").
 */
export const authSelectors = {
  login: {
    emailField: /textbox "email\*"/i,
    passwordField: /textbox "password\*"/i,
    submitButton: [/button "start creating"/i, /button "log in"/i],
    toggleFromSignup: /button "log in"/i,
    forgotPassword: /button "forgot password\?"/i,
  },
  signup: {
    fullNameField: /textbox "full name\*"/i,
    emailField: /textbox "email\*"/i,
    passwordField: /textbox "password\*"/i,
    confirmPasswordField: /textbox "confirm password\*"/i,
    submitButton: /button "continue"/i,
    toggleFromLogin: /button "sign up"/i,
    otpDigitField: (n: number) => new RegExp(`textbox "Digit ${n}"`, 'i'),
    verifyOtpButton: /button "verify otp"/i,
  },
  forgotPassword: {
    emailField: /textbox "email\*"/i,
    sendButton: /button "send new password"/i,
    backToLogin: /button "back to login"/i,
    codeField: [
      /textbox "code\*"/i,
      /textbox "verification code\*"/i,
      /textbox "otp\*"/i,
      /textbox "temp password\*"/i,
    ],
    newPasswordField: [/textbox "new password\*"/i, /textbox "password\*"/i],
    confirmPasswordField: /textbox "confirm password\*"/i,
    submitButton: [/button "reset password"/i, /button "submit"/i, /button "continue"/i],
  },
} as const;

export function isLoginFormSnapshot(snapshot: string): boolean {
  const hasPassword = authSelectors.login.passwordField.test(snapshot);
  const hasEmail = authSelectors.login.emailField.test(snapshot);
  const isSignup = authSelectors.signup.fullNameField.test(snapshot);
  const isForgotSend = authSelectors.forgotPassword.sendButton.test(snapshot);
  return hasEmail && hasPassword && !isSignup && !isForgotSend;
}

export function isSignupFormSnapshot(snapshot: string): boolean {
  return authSelectors.signup.fullNameField.test(snapshot);
}

export function isForgotPasswordRequestSnapshot(snapshot: string): boolean {
  return (
    authSelectors.forgotPassword.emailField.test(snapshot) &&
    authSelectors.forgotPassword.sendButton.test(snapshot)
  );
}

export function isForgotPasswordCodeSnapshot(snapshot: string): boolean {
  return authSelectors.forgotPassword.codeField.some((p) => p.test(snapshot));
}

export function isSignupOtpSnapshot(snapshot: string): boolean {
  return (
    /verify otp/i.test(snapshot) &&
    authSelectors.signup.otpDigitField(1).test(snapshot)
  );
}
