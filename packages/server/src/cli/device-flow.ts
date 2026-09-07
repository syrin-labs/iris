/**
 * The browser device flow's wire shapes and its hand-off to a real browser.
 *
 * `reticle login` works like `gh auth login`: the CLI asks the cloud for a device code, opens the
 * approval page, and polls until a human confirms it in a session that is already signed in. That
 * confirmation is the whole security of the flow — only somebody already authenticated in the
 * dashboard can turn a device code into a token for their org.
 *
 * Split from `cloud-cli` because it is self-contained: the schemas describe two endpoints and the
 * opener knows only about platforms. Nothing here reads a session, a credential, or a project.
 */
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { NodePlatform } from '../platform.js';

/** What `/v1/auth/device/start` answers: the codes, where to approve, and how fast to poll. */
export const DeviceStartSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string(),
  interval: z.number(),
  expiresAt: z.number(),
});

/**
 * What `/v1/auth/device/token` answers while polling. Everything past `status` is optional because
 * only an APPROVED poll carries a token, and `org.id` is absent on a cloud older than org-scoped
 * credentials.
 */
export const DevicePollSchema = z.object({
  status: z.string(),
  token: z.string().optional(),
  org: z.object({ id: z.string().optional(), name: z.string() }).optional(),
});

/**
 * Best-effort open the approval page in the default browser.
 *
 * Every failure is swallowed on purpose: the URL is printed either way, and a headless box, a
 * container, or an SSH session has no opener at all. Refusing to log in because a convenience did
 * not work would break the one environment that most needs the printed fallback.
 */
export const openBrowser = (target: string): void => {
  const cmd =
    NodePlatform.MACOS === process.platform
      ? 'open'
      : NodePlatform.WINDOWS === process.platform
        ? 'cmd'
        : 'xdg-open';
  const args = NodePlatform.WINDOWS === process.platform ? ['/c', 'start', '', target] : [target];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* no opener available — the user opens the printed URL manually */
  }
};
