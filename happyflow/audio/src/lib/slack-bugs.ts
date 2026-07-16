/**
 * Post Koyal product-bug reports to the Slack bugs channel via incoming webhook.
 * Webhook URL: SLACK_BUGS_WEBHOOK_URL (loaded from login/.env).
 */
export async function notifySlackBugs(opts: {
  suite: 'audio' | 'script' | 'login';
  runId: string;
  markdown: string;
}): Promise<boolean> {
  const url = process.env.SLACK_BUGS_WEBHOOK_URL?.trim();
  if (!url) {
    console.log('[slack] SLACK_BUGS_WEBHOOK_URL not set — skipping bug notify');
    return false;
  }

  const body = opts.markdown.trim();
  if (!body) return false;

  // Slack text limit ~40k; keep a safe margin
  const clipped = body.length > 35_000 ? `${body.slice(0, 35_000)}\n… _(truncated)_` : body;
  const text =
    `*happyflow ${opts.suite}* · run \`${opts.runId}\` · Koyal product bugs\n` +
    '```\n' +
    clipped +
    '\n```';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const t = await res.text();
    if (!res.ok || t !== 'ok') {
      console.warn(`[slack] notify failed: ${res.status} ${t}`);
      return false;
    }
    console.log('[slack] bug report posted to bugs channel');
    return true;
  } catch (err) {
    console.warn(`[slack] notify error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
