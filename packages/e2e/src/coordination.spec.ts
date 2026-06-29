import { test, expect } from '@playwright/test';

test.describe('Connexis Multi-Tab E2E Tests', () => {
  test('should elect leader, delegate subscriptions, and failover when leader exits', async ({ context }) => {
    // 1. Open Tab A (will become Leader)
    const pageA = await context.newPage();
    await pageA.goto('/');

    // Verify Tab A promotes itself to Leader
    const leaderBadge = pageA.locator('.role-badge');
    await expect(leaderBadge).toHaveText('Leader', { timeout: 5000 });

    // Verify Tab A has 1 active transport connection
    const connCountA = pageA.locator('.status-row:has-text("Active Connection Count") .status-value');
    await expect(connCountA).toHaveText('1');

    // 2. Open Tab B (will become Follower)
    const pageB = await context.newPage();
    await pageB.goto('/');

    // Verify Tab B promotes itself to Follower
    const followerBadge = pageB.locator('.role-badge');
    await expect(followerBadge).toHaveText('Follower', { timeout: 5000 });

    // Verify Tab B has 0 active transport connections (delegates to Tab A)
    const connCountB = pageB.locator('.status-row:has-text("Active Connection Count") .status-value');
    await expect(connCountB).toHaveText('0');

    // Verify Tab B receives ticker feed logs delegated from Tab A
    const terminalLogsB = pageB.locator('.terminal-body');
    await expect(terminalLogsB).toContainText('TICKS', { timeout: 5000 });

    // 3. Test publish forwarding from Follower to Leader
    const chatInput = pageB.locator('.form-input[placeholder="Type a message..."]');
    const publishBtn = pageB.locator('button[type="submit"]:has-text("Publish to \'chat\'")');

    await chatInput.fill('Hello from Follower Tab');
    await publishBtn.click();

    // Verify chat message propagates and appears in both tabs' terminals
    await expect(pageA.locator('.terminal-body')).toContainText('Hello from Follower Tab', { timeout: 5000 });
    await expect(pageB.locator('.terminal-body')).toContainText('Hello from Follower Tab', { timeout: 5000 });

    // 4. Test Failover: Close Tab A (Leader)
    await pageA.close();

    // Verify Tab B is promoted to Leader automatically
    await expect(followerBadge).toHaveText('Leader', { timeout: 5000 });
    await expect(connCountB).toHaveText('1', { timeout: 5000 });

    // Verify event logs continue streaming
    await expect(terminalLogsB).toContainText('TICKS', { timeout: 5000 });

    await pageB.close();
  });
});
