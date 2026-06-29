import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../config.js';

function codeFile(name: string): string {
  fs.mkdirSync(config.stateDir, { recursive: true });
  return path.join(config.stateDir, name);
}

async function waitForCodeFile(filePath: string, label: string): Promise<string> {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Waiting for ${label}…`);
  console.log(`  Write the code to: ${filePath}`);
  console.log(
    `  (single line, save the file — polls every ${config.codePollMs / 1000}s, max ${config.codeWaitMs / 1000}s)`,
  );
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');
  console.log(`  Created empty file — paste your code there and save.\n`);

  const deadline = Date.now() + config.codeWaitMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const code = fs.readFileSync(filePath, 'utf8').trim();
      if (code) {
        fs.unlinkSync(filePath);
        console.log(`\n✓ Received ${label} (${code.length} chars)\n`);
        return code;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, config.codePollMs));
  }

  throw new Error(
    `Timed out after ${config.codeWaitMs / 1000}s waiting for ${label} in ${filePath}`,
  );
}

async function promptCodeInteractive(promptLabel: string, header: string): Promise<string> {
  console.log(`\n${header}\n`);

  const rl = readline.createInterface({ input, output });
  try {
    const code = (await rl.question(`${promptLabel}: `)).trim();
    if (!code) {
      throw new Error(`No ${promptLabel.toLowerCase()} entered`);
    }
    return code;
  } finally {
    rl.close();
  }
}

async function promptCode(options: {
  envVar?: string;
  envLabel: string;
  fileName: string;
  fileLabel: string;
  promptLabel: string;
  header: string;
}): Promise<string> {
  if (options.envVar?.trim()) {
    console.log(`\nUsing ${options.envLabel} from env var.`);
    return options.envVar.trim();
  }

  const filePath = codeFile(options.fileName);
  const useInteractive =
    process.env.KOYAL_CODE_PROMPT_INTERACTIVE === 'true' && input.isTTY;
  if (useInteractive) {
    return promptCodeInteractive(options.promptLabel, options.header);
  }

  return waitForCodeFile(filePath, options.fileLabel);
}

export async function promptVerificationCode(): Promise<string> {
  return promptCode({
    envVar: process.env.KOYAL_RESET_CODE,
    envLabel: 'verification code',
    fileName: 'reset-code.txt',
    fileLabel: 'password reset code',
    promptLabel: 'Verification code',
    header: [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '  CHECK YOUR EMAIL for the reset verification code.',
      `  Account: ${config.resetEmail}`,
      '  Paste the code below and press Enter:',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'),
  });
}

export async function promptSignupOtp(): Promise<string> {
  return promptCode({
    envVar: process.env.KOYAL_SIGNUP_OTP,
    envLabel: 'signup OTP',
    fileName: 'signup-otp.txt',
    fileLabel: 'signup OTP',
    promptLabel: 'Signup OTP',
    header: [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '  CHECK YOUR EMAIL for the signup verification code.',
      `  Account: ${config.signupEmail}`,
      '  Paste the 6-digit OTP below and press Enter:',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n'),
  });
}

export function resetNewPassword(): string {
  return (
    process.env.KOYAL_RESET_NEW_PASSWORD?.trim() ??
    `KoyalQa!${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  );
}
