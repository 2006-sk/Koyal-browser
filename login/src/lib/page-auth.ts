import { config } from '../config.js';
import { isPostAuthUrl } from './auth-expectations.js';
import {
  authSelectors,
  isForgotPasswordCodeSnapshot,
  isForgotPasswordRequestSnapshot,
  isLoginFormSnapshot,
  isSignupFormSnapshot,
  isSignupOtpSnapshot,
} from './auth-selectors.js';
import {
  AgentBrowser,
  refForInteractiveSnapshot,
  snapshotIncludes,
} from './agent-browser.js';
import { Explorer, type ExplorerResult } from './explorer.js';
import { NavigationHarness, type NavigationResult } from './nav-harness.js';

export interface AuthNavigationResult {
  mode: 'deterministic' | 'explored';
  action: string;
  explorer?: ExplorerResult;
  deterministicFailedReason?: string;
}

/** Auth navigation — deterministic selectors first, LLM exploration only on failure. */
export class AuthPage {
  private readonly harness: NavigationHarness;

  constructor(private readonly browser: AgentBrowser) {
    const explorer = config.llm.enabled ? new Explorer(browser) : null;
    this.harness = new NavigationHarness(explorer);
  }

  loginUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, '')}/login`;
  }

  openLogin(baseUrl: string): void {
    this.browser.open(this.loginUrl(baseUrl));
  }

  private toAuthResult(result: NavigationResult): AuthNavigationResult {
    return {
      mode: result.mode,
      action: result.action,
      explorer: result.explorer,
      deterministicFailedReason: result.deterministicFailedReason,
    };
  }

  private firstRef(snapshot: string, patterns: RegExp | readonly RegExp[]): string | null {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    for (const pattern of list) {
      const ref = refForInteractiveSnapshot(snapshot, pattern);
      if (ref) return ref;
    }
    return null;
  }

  async ensureLoginForm(): Promise<AuthNavigationResult> {
    const result = await this.harness.run({
      action: 'ensure-login-form',
      verify: () => isLoginFormSnapshot(this.browser.snapshotInteractive()),
      deterministic: () => {
        const snap = this.browser.snapshotInteractive();
        if (isLoginFormSnapshot(snap)) return;
        const toggle = refForInteractiveSnapshot(snap, authSelectors.login.toggleFromSignup);
        if (!toggle) throw new Error('Login toggle button not found in snapshot');
        this.browser.clickVisible(toggle);
      },
      exploreGoal:
        'Show the login form (email + password fields). If signup form is visible, click the toggle to switch to login. Do not submit.',
    });
    return this.toAuthResult(result);
  }

  async ensureSignupForm(): Promise<AuthNavigationResult> {
    const result = await this.harness.run({
      action: 'ensure-signup-form',
      verify: () => isSignupFormSnapshot(this.browser.snapshotInteractive()),
      deterministic: () => {
        const snap = this.browser.snapshotInteractive();
        if (isSignupFormSnapshot(snap)) return;
        const toggle = refForInteractiveSnapshot(snap, authSelectors.signup.toggleFromLogin);
        if (!toggle) throw new Error('Sign up toggle button not found in snapshot');
        this.browser.clickVisible(toggle);
      },
      exploreGoal:
        'Show the signup form (full name, email, password, confirm password). If login form is visible, click the toggle to switch to signup. Do not submit.',
    });
    return this.toAuthResult(result);
  }

  async openForgotPassword(): Promise<AuthNavigationResult> {
    await this.ensureLoginForm();

    const result = await this.harness.run({
      action: 'open-forgot-password',
      verify: () => isForgotPasswordRequestSnapshot(this.browser.snapshotInteractive()) ||
        isForgotPasswordCodeSnapshot(this.browser.snapshotInteractive()),
      deterministic: () => {
        const snap = this.browser.snapshotInteractive();
        const forgotRef = refForInteractiveSnapshot(snap, authSelectors.login.forgotPassword);
        if (!forgotRef) throw new Error('Forgot password button not found');
        this.browser.clickVisible(forgotRef);
      },
      exploreGoal:
        'Open the forgot-password flow by clicking "Forgot password?". Stop when the reset email form is visible (email field and send button).',
    });
    return this.toAuthResult(result);
  }

  async requestPasswordReset(email: string): Promise<AuthNavigationResult> {
    await this.openForgotPassword();

    const result = await this.harness.run({
      action: 'request-password-reset',
      verify: () => {
        const snap = this.browser.snapshotInteractive();
        return (
          isForgotPasswordCodeSnapshot(snap) ||
          snapshotIncludes(snap, 'sent') ||
          snapshotIncludes(snap, 'check your email')
        );
      },
      deterministic: () => {
        const snap = this.browser.snapshotInteractive();
        if (isForgotPasswordCodeSnapshot(snap)) return;

        const emailRef = refForInteractiveSnapshot(snap, authSelectors.forgotPassword.emailField);
        const sendRef = refForInteractiveSnapshot(snap, authSelectors.forgotPassword.sendButton);
        if (!emailRef || !sendRef) throw new Error('Forgot-password request form not found');
        this.browser.fillVisible(emailRef, email);
        this.browser.clickVisible(sendRef);
        this.browser.wait(2500);
      },
      exploreGoal: `On the forgot-password form, fill email with exactly "${email}" and click send reset (e.g. "Send new password"). Do not enter verification code yet.`,
    });
    return this.toAuthResult(result);
  }

  async completePasswordReset(code: string, newPassword: string): Promise<AuthNavigationResult> {
    const result = await this.harness.run({
      action: 'complete-password-reset',
      verify: () => {
        const url = this.browser.getUrl();
        if (isPostAuthUrl(url)) return true;
        const snap = this.browser.snapshotInteractive();
        return (
          isLoginFormSnapshot(snap) ||
          snapshotIncludes(snap, 'success') ||
          snapshotIncludes(snap, 'password updated')
        );
      },
      deterministic: () => {
        let snap = this.browser.snapshotInteractive();
        const codeRef = this.firstRef(snap, authSelectors.forgotPassword.codeField);
        if (codeRef) this.browser.fillVisible(codeRef, code);

        snap = this.browser.snapshotInteractive();
        const passRef = this.firstRef(snap, authSelectors.forgotPassword.newPasswordField);
        if (passRef) this.browser.fillVisible(passRef, newPassword);

        snap = this.browser.snapshotInteractive();
        const confirmRef = refForInteractiveSnapshot(
          snap,
          authSelectors.forgotPassword.confirmPasswordField,
        );
        if (confirmRef) this.browser.fillVisible(confirmRef, newPassword);

        snap = this.browser.snapshotInteractive();
        const submitRef = this.firstRef(snap, authSelectors.forgotPassword.submitButton);
        if (submitRef) {
          this.browser.clickVisible(submitRef);
          this.browser.wait(2500);
        }
      },
      exploreGoal: `Complete password reset: enter verification code exactly "${code}", set new password exactly "${newPassword}" (confirm if required), then submit.`,
    });
    return this.toAuthResult(result);
  }

  async fillLogin(email: string, password: string, skipEnsure = false): Promise<AuthNavigationResult> {
    if (!skipEnsure) {
      await this.ensureLoginForm();
    }

    let filled = false;

    const result = await this.harness.run({
      action: 'fill-login',
      mustRunAction: true,
      verify: () => filled,
      deterministic: () => {
        let snap = this.browser.snapshotInteractive();
        const emailRef = refForInteractiveSnapshot(snap, authSelectors.login.emailField);
        const passwordRef = refForInteractiveSnapshot(snap, authSelectors.login.passwordField);
        if (!emailRef || !passwordRef) throw new Error('Login fields not found');
        this.browser.fillVisible(emailRef, email);
        snap = this.browser.snapshotInteractive();
        const passwordRef2 = refForInteractiveSnapshot(snap, authSelectors.login.passwordField);
        if (!passwordRef2) throw new Error('Password field ref lost after fill');
        this.browser.fillVisible(passwordRef2, password);
        filled = true;
      },
      exploreGoal: `On the login form, fill email with exactly "${email}" and password with exactly "${password}". Do not submit yet.`,
    });
    return this.toAuthResult(result);
  }

  async submitLogin(): Promise<AuthNavigationResult> {
    let clicked = false;

    const result = await this.harness.run({
      action: 'submit-login',
      mustRunAction: true,
      verify: () => {
        if (clicked) return true;
        const url = this.browser.getUrl();
        if (isPostAuthUrl(url)) return true;
        const err = this.visibleUserFacingErrorText(this.browser.snapshotInteractive());
        return Boolean(err);
      },
      deterministic: () => {
        const snap = this.browser.snapshotInteractive();
        const submitRef = this.firstRef(snap, authSelectors.login.submitButton);
        if (!submitRef) throw new Error('Login submit button not found');
        this.browser.clickVisible(submitRef);
        clicked = true;
      },
      exploreGoal:
        'Submit the login form by clicking the primary submit button (e.g. "Start Creating").',
    });
    return this.toAuthResult(result);
  }

  async fillSignup(
    fullName: string,
    email: string,
    password: string,
    skipEnsure = false,
  ): Promise<AuthNavigationResult> {
    return this.fillSignupFields(fullName, email, password, password, skipEnsure);
  }

  async fillSignupFields(
    fullName: string,
    email: string,
    password: string,
    confirmPassword: string,
    skipEnsure = false,
  ): Promise<AuthNavigationResult> {
    if (!skipEnsure) {
      await this.ensureSignupForm();
    }

    let filled = false;

    const result = await this.harness.run({
      action: 'fill-signup',
      mustRunAction: true,
      verify: () => filled,
      deterministic: () => {
        let snap = this.browser.snapshotInteractive();
        const nameRef = refForInteractiveSnapshot(snap, authSelectors.signup.fullNameField);
        const emailRef = refForInteractiveSnapshot(snap, authSelectors.signup.emailField);
        const passwordRef = refForInteractiveSnapshot(snap, authSelectors.signup.passwordField);
        const confirmRef = refForInteractiveSnapshot(snap, authSelectors.signup.confirmPasswordField);
        if (!nameRef || !emailRef || !passwordRef || !confirmRef) {
          throw new Error('Signup form fields not found');
        }
        this.browser.fillVisible(nameRef, fullName);
        snap = this.browser.snapshotInteractive();
        const emailRef2 = refForInteractiveSnapshot(snap, authSelectors.signup.emailField);
        if (!emailRef2) throw new Error('Email field ref lost after fill');
        this.browser.fillVisible(emailRef2, email);
        snap = this.browser.snapshotInteractive();
        const passwordRef2 = refForInteractiveSnapshot(snap, authSelectors.signup.passwordField);
        if (!passwordRef2) throw new Error('Password field ref lost after fill');
        this.browser.fillVisible(passwordRef2, password);
        snap = this.browser.snapshotInteractive();
        const confirmRef2 = refForInteractiveSnapshot(snap, authSelectors.signup.confirmPasswordField);
        if (!confirmRef2) throw new Error('Confirm password field ref lost after fill');
        this.browser.fillVisible(confirmRef2, confirmPassword);
        filled = true;
      },
      exploreGoal: `On the signup form, fill full name "${fullName}", email "${email}", password "${password}", confirm "${confirmPassword}". Do not submit yet.`,
    });
    return this.toAuthResult(result);
  }

  async submitSignup(): Promise<AuthNavigationResult> {
    let clicked = false;

    const result = await this.harness.run({
      action: 'submit-signup',
      mustRunAction: true,
      verify: () => {
        if (clicked) return true;
        const url = this.browser.getUrl();
        if (isPostAuthUrl(url)) return true;
        const snap = this.browser.snapshotInteractive();
        if (isSignupOtpSnapshot(snap)) return true;
        if (this.visibleSignupErrorText(snap)) return true;
        return false;
      },
      deterministic: () => {
        const snap = this.browser.snapshotInteractive();
        const submitRef = refForInteractiveSnapshot(snap, authSelectors.signup.submitButton);
        if (!submitRef) throw new Error('Signup submit button (Continue) not found');
        this.browser.clickVisible(submitRef);
        clicked = true;
      },
      exploreGoal: 'Submit the signup form by clicking the Continue button.',
    });
    return this.toAuthResult(result);
  }

  async verifySignupOtp(code: string): Promise<AuthNavigationResult> {
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) {
      throw new Error(`Signup OTP must be 6 digits (got ${digits.length})`);
    }

    const result = await this.harness.run({
      action: 'verify-signup-otp',
      mustRunAction: true,
      verify: () => {
        const url = this.browser.getUrl();
        if (isPostAuthUrl(url)) return true;
        const snap = this.browser.snapshotInteractive();
        return Boolean(this.visibleSignupErrorText(snap));
      },
      deterministic: () => {
        for (let i = 1; i <= 6; i++) {
          const snap = this.browser.snapshotInteractive();
          const digitRef = refForInteractiveSnapshot(snap, authSelectors.signup.otpDigitField(i));
          if (!digitRef) throw new Error(`OTP digit ${i} field not found`);
          this.browser.fillVisible(digitRef, digits[i - 1]!);
        }
        const snap = this.browser.snapshotInteractive();
        const verifyRef = refForInteractiveSnapshot(snap, authSelectors.signup.verifyOtpButton);
        if (!verifyRef) throw new Error('Verify OTP button not found');
        this.browser.clickVisible(verifyRef);
      },
      exploreGoal: `On the Verify OTP screen, enter the 6-digit code "${code}" and click Verify OTP.`,
    });
    return this.toAuthResult(result);
  }

  async backToLoginFromForgot(): Promise<AuthNavigationResult> {
    const result = await this.harness.run({
      action: 'back-to-login-from-forgot',
      verify: () => isLoginFormSnapshot(this.browser.snapshotInteractive()),
      deterministic: () => {
        const snap = this.browser.snapshotInteractive();
        const backRef = refForInteractiveSnapshot(snap, authSelectors.forgotPassword.backToLogin);
        if (backRef) {
          this.browser.clickVisible(backRef);
          return;
        }
        const loginToggle = refForInteractiveSnapshot(snap, authSelectors.login.toggleFromSignup);
        if (loginToggle) this.browser.clickVisible(loginToggle);
        else this.browser.back();
      },
      exploreGoal: 'Return to the login form from forgot-password (Back to Login or browser back).',
    });
    return this.toAuthResult(result);
  }

  fillLoginEmailOnly(email: string): void {
    const snap = this.browser.snapshotInteractive();
    const emailRef = refForInteractiveSnapshot(snap, authSelectors.login.emailField);
    if (!emailRef) throw new Error('Login email field not found');
    this.browser.fillVisible(emailRef, email);
  }

  hasGoogleOAuthButton(snapshot: string): boolean {
    return /google|continue with google|sign up with google/i.test(snapshot);
  }

  visibleUserFacingErrorText(snapshot: string): string | null {
    const patterns = [
      /User not found\./i,
      /Please enter a valid email/i,
      /invalid (email|password|credentials)/i,
      /incorrect password/i,
      /wrong password/i,
      /account not found/i,
      /already (exists|registered)/i,
      /email already/i,
    ];
    for (const pattern of patterns) {
      const match = snapshot.match(pattern);
      if (match) return match[0];
    }
    return null;
  }

  visibleSignupErrorText(snapshot: string): string | null {
    const validationPatterns = [
      /passwords? do not match/i,
      /do not match/i,
      /at least 6 character/i,
      /uppercase/i,
      /lowercase/i,
      /one number/i,
      /required/i,
      /please enter/i,
      /invalid/i,
    ];
    for (const pattern of validationPatterns) {
      const match = snapshot.match(pattern);
      if (match) return match[0];
    }
    return this.visibleUserFacingErrorText(snapshot);
  }

  appendExplorerSteps(repro: string[], nav?: AuthNavigationResult): void {
    if (nav?.mode === 'explored' && nav.explorer?.stepsTaken.length) {
      repro.push(`[explored after deterministic failed: ${nav.deterministicFailedReason ?? 'unknown'}]`);
      for (const step of nav.explorer.stepsTaken) {
        repro.push(`[LLM] ${step}`);
      }
    } else if (nav?.mode === 'deterministic') {
      repro.push(`[deterministic] ${nav.action}`);
    }
  }

  collectExplorerSteps(...navs: Array<AuthNavigationResult | undefined>): string[] {
    const steps: string[] = [];
    for (const nav of navs) {
      if (nav?.mode === 'deterministic') {
        steps.push(`[deterministic] ${nav.action}`);
      } else if (nav?.explorer?.stepsTaken) {
        steps.push(`[explored] ${nav.action} (deterministic failed: ${nav.deterministicFailedReason ?? '?'})`);
        steps.push(...nav.explorer.stepsTaken.map((s) => `[LLM] ${s}`));
      }
    }
    return steps;
  }
}
