import { config } from '../config.js';
import type { AgentBrowser } from './agent-browser.js';
import { LlmClient, parseJsonFromLlm } from './llm/client.js';

export type ExplorerActionType = 'click' | 'fill' | 'wait' | 'done' | 'fail';

export interface ExplorerAction {
  action: ExplorerActionType;
  ref?: string;
  value?: string;
  reason?: string;
}

export interface ExplorerResult {
  goal: string;
  success: boolean;
  actions: ExplorerAction[];
  stepsTaken: string[];
  finalUrl: string;
  finalSnapshot: string;
  error?: string;
}

const SYSTEM_PROMPT = `You are the exploration layer for an automated QA agent testing beta.koyal.ai.

You receive an accessibility snapshot with @ref element IDs (e.g. @e4). Your job is to choose the NEXT single browser action to progress toward the stated goal.

Rules:
- Only use refs that appear in the current snapshot.
- Prefer semantic matches (button names, field labels) over guessing.
- For fill actions, use the exact value provided in the goal when filling credentials.
- Use action "done" when the goal is clearly achieved in the current snapshot/URL.
- Use action "fail" only if the goal is impossible (e.g. element missing after reasonable attempt).
- Never click Dashboard when inside the video creation wizard (sidebar Dashboard exits the flow).
- Respond with JSON only, no markdown.

JSON schema:
{
  "action": "click" | "fill" | "wait" | "done" | "fail",
  "ref": "@eN",
  "value": "string for fill only",
  "reason": "brief explanation"
}`;

export class Explorer {
  private readonly llm: LlmClient;

  constructor(
    private readonly browser: AgentBrowser,
    llm?: LlmClient,
  ) {
    this.llm = llm ?? new LlmClient();
  }

  async achieveGoal(goal: string, options?: { maxSteps?: number }): Promise<ExplorerResult> {
    const maxSteps = options?.maxSteps ?? config.llm.maxStepsPerGoal;
    const actions: ExplorerAction[] = [];
    const stepsTaken: string[] = [];

    console.log(`\n[explorer] Goal: ${goal.slice(0, 120)}${goal.length > 120 ? '…' : ''}`);

    for (let step = 0; step < maxSteps; step++) {
      const snapshot = this.browser.snapshotInteractive();
      const url = this.browser.getUrl();

      console.log(`  [explorer] step ${step + 1}/${maxSteps} — asking LLM (url: ${url})...`);
      const llmStart = Date.now();
      const decision = await this.decideNextAction(goal, url, snapshot, stepsTaken);
      console.log(
        `  [explorer] LLM responded in ${Date.now() - llmStart}ms → ${decision.action}${decision.ref ? ` ${decision.ref}` : ''}${decision.reason ? ` (${decision.reason})` : ''}`,
      );

      actions.push(decision);
      stepsTaken.push(
        `${decision.action}${decision.ref ? ` ${decision.ref}` : ''}${decision.value ? ` "${decision.value}"` : ''} — ${decision.reason ?? ''}`.trim(),
      );

      if (decision.action === 'done') {
        return {
          goal,
          success: true,
          actions,
          stepsTaken,
          finalUrl: url,
          finalSnapshot: snapshot,
        };
      }

      if (decision.action === 'fail') {
        return {
          goal,
          success: false,
          actions,
          stepsTaken,
          finalUrl: url,
          finalSnapshot: snapshot,
          error: decision.reason ?? 'Explorer reported goal impossible',
        };
      }

      try {
        await this.executeAction(decision);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        stepsTaken.push(`action failed: ${msg}`);
        console.warn(`  [explorer] action failed (will re-snapshot): ${msg}`);
      }
      this.browser.wait(config.actionDelayMs);
    }

    return {
      goal,
      success: false,
      actions,
      stepsTaken,
      finalUrl: this.browser.getUrl(),
      finalSnapshot: this.browser.snapshotInteractive(),
      error: `Exceeded max exploration steps (${maxSteps})`,
    };
  }

  private async decideNextAction(
    goal: string,
    url: string,
    snapshot: string,
    priorSteps: string[],
  ): Promise<ExplorerAction> {
    const userPrompt = [
      `Goal: ${goal}`,
      `Current URL: ${url}`,
      priorSteps.length ? `Prior steps:\n${priorSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : 'Prior steps: none',
      'Interactive snapshot:',
      snapshot,
    ].join('\n\n');

    const raw = await this.llm.complete({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const parsed = parseJsonFromLlm<ExplorerAction>(raw);
    if (!parsed.action) {
      throw new Error(`Invalid explorer response: ${raw}`);
    }
    return parsed;
  }

  private async executeAction(decision: ExplorerAction): Promise<void> {
    switch (decision.action) {
      case 'click':
        if (!decision.ref) throw new Error('Explorer click missing ref');
        this.browser.clickVisible(decision.ref);
        break;
      case 'fill':
        if (!decision.ref || decision.value === undefined) {
          throw new Error('Explorer fill missing ref or value');
        }
        this.browser.fillVisible(decision.ref, decision.value);
        break;
      case 'wait':
        this.browser.wait(1500);
        break;
      default:
        break;
    }
  }
}
