import { test, expect } from '@playwright/test';

test.describe('Connexis Multi-Tab E2E Tests', () => {
  test('should elect leader, delegate subscriptions, and failover when leader exits', async ({ context }) => {
    // 1. Open Tab A (will become Leader)
    const pageA = await context.newPage();
    await pageA.goto('/');

    // Verify Tab A promotes itself to Leader
    const leaderBadge = pageA.locator('.role-dot-badge');
    await expect(leaderBadge).toHaveText('LEADER', { timeout: 8000 });

    // Verify Tab A has 1 active transport connection
    const connCountA = pageA.locator('.status-row:has-text("Active Connection Count") .status-value');
    await expect(connCountA).toHaveText('1');

    // 2. Open Tab B (will become Follower)
    const pageB = await context.newPage();
    await pageB.goto('/');

    // Verify Tab B promotes itself to Follower
    const followerBadge = pageB.locator('.role-dot-badge');
    await expect(followerBadge).toHaveText('FOLLOWER', { timeout: 8000 });

    // Verify Tab B has 0 active transport connections (delegates to Tab A)
    const connCountB = pageB.locator('.status-row:has-text("Active Connection Count") .status-value');
    await expect(connCountB).toHaveText('0');

    // 3. Test Failover: Close Tab A (Leader)
    await pageA.close();

    // Verify Tab B is promoted to Leader automatically
    await expect(followerBadge).toHaveText('LEADER', { timeout: 8000 });
    await expect(connCountB).toHaveText('1', { timeout: 8000 });

    await pageB.close();
  });

  test('should support dynamic transport switching and manual connection toggling', async ({ page }) => {
    await page.goto('/');

    const stateVal = page.locator('.status-row:has-text("Client Lifecycle State") .status-value');
    const connCount = page.locator('.status-row:has-text("Active Connection Count") .status-value');
    const toggleBtn = page.locator('button.btn:has-text("Disconnect Socket"), button.btn:has-text("Connect Socket")');
    const transportSelect = page.locator('select.form-select');

    // Verify initial connection
    await expect(stateVal).toHaveText('CONNECTED', { timeout: 8000 });
    await expect(connCount).toHaveText('1');

    // 1. Test manual disconnect
    await toggleBtn.click();
    await expect(stateVal).toHaveText('CLOSED', { timeout: 8000 });
    await expect(connCount).toHaveText('0');

    // 2. Test manual reconnect
    await toggleBtn.click();
    await expect(stateVal).toHaveText('CONNECTED', { timeout: 8000 });
    await expect(connCount).toHaveText('1');

    // 3. Test dynamic transport switching (WebSocket -> SSE)
    await transportSelect.selectOption('SSE');
    await expect(stateVal).toHaveText('CONNECTED', { timeout: 8000 });
    await expect(connCount).toHaveText('1');
  });

  test('should support isolated connection policy', async ({ context }) => {
    // 1. Open Tab A with ?policy=isolated
    const pageA = await context.newPage();
    await pageA.goto('/?policy=isolated');

    const stateValA = pageA.locator('.status-row:has-text("Client Lifecycle State") .status-value');
    await expect(stateValA).toHaveText('CONNECTED', { timeout: 8000 });

    const connCountA = pageA.locator('.status-row:has-text("Active Connection Count") .status-value');
    await expect(connCountA).toHaveText('1');

    // 2. Open Tab B with ?policy=isolated
    const pageB = await context.newPage();
    await pageB.goto('/?policy=isolated');

    const stateValB = pageB.locator('.status-row:has-text("Client Lifecycle State") .status-value');
    await expect(stateValB).toHaveText('CONNECTED', { timeout: 8000 });

    const connCountB = pageB.locator('.status-row:has-text("Active Connection Count") .status-value');
    // In isolated mode, Tab B should connect directly and also have 1 active connection!
    await expect(connCountB).toHaveText('1', { timeout: 8000 });

    await pageA.close();
    await pageB.close();
  });
});
