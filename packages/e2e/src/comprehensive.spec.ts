import { test, expect } from '@playwright/test';

const transports = ['WebSocket', 'SSE', 'Polling'];

test.describe('Connexis Comprehensive & Resiliency E2E Suite', () => {
  for (const transport of transports) {
    test.describe(`Transport Protocol: ${transport}`, () => {
      
      test('should elect leader, delegate connections, and sync Tic-Tac-Toe play side-by-side', async ({ context }) => {
        // 1. Open Tab A (will become Leader)
        const pageA = await context.newPage();
        await pageA.goto('/');

        // Set transport protocol
        const selectA = pageA.locator('select.form-select');
        await selectA.selectOption(transport);
        
        const badgeA = pageA.locator('.role-dot-badge');
        await expect(badgeA).toHaveText('LEADER', { timeout: 8000 });

        const connCountA = pageA.locator('.status-row:has-text("Active Connection Count") .status-value');
        await expect(connCountA).toHaveText('1');

        // 2. Open Tab B (will become Follower)
        const pageB = await context.newPage();
        await pageB.goto('/');

        // Set transport protocol on B
        const selectB = pageB.locator('select.form-select');
        await selectB.selectOption(transport);

        const badgeB = pageB.locator('.role-dot-badge');
        await expect(badgeB).toHaveText('FOLLOWER', { timeout: 8000 });

        const connCountB = pageB.locator('.status-row:has-text("Active Connection Count") .status-value');
        await expect(connCountB).toHaveText('0');

        // Navigate both to Tic-Tac-Toe view
        await pageA.click('li.nav-item:has-text("Tic-Tac-Toe")');
        await pageB.click('li.nav-item:has-text("Tic-Tac-Toe")');

        // Reset board to clear previous plays
        await pageA.click('button:has-text("Reset Board")');
        await pageB.waitForTimeout(1000); // allow state broadcast to settle

        // Tab A Joins as X
        await pageA.click('button:has-text("Join as Player X")');
        // Tab B Joins as O
        await pageB.click('button:has-text("Join as Player O")');

        const cellsA = pageA.locator('div[style*="grid-template-columns"] button');
        const cellsB = pageB.locator('div[style*="grid-template-columns"] button');

        // Tab A makes center move (index 4)
        console.log(`[${transport}] Tab A placing X at index 4...`);
        await cellsA.nth(4).click();
        await expect(cellsA.nth(4)).toHaveText('X', { timeout: 3000 });
        await expect(cellsB.nth(4)).toHaveText('X', { timeout: 3000 });

        // Tab B makes top-left move (index 0)
        console.log(`[${transport}] Tab B placing O at index 0...`);
        await cellsB.nth(0).click();
        await expect(cellsA.nth(0)).toHaveText('O', { timeout: 3000 });
        await expect(cellsB.nth(0)).toHaveText('O', { timeout: 3000 });

        // Verify reset coordinates properly
        await pageA.click('button:has-text("Reset Board")');
        await expect(cellsA.nth(4)).toHaveText('');
        await expect(cellsB.nth(4)).toHaveText('');

        await pageA.close();
        await pageB.close();
      });

      test('should verify subscription reference counting during view navigation changes', async ({ page }) => {
        // Navigate to homepage
        await page.goto('/');

        // Set transport protocol
        const select = page.locator('select.form-select');
        await select.selectOption(transport);

        // Initialize connection
        const stateVal = page.locator('.status-row:has-text("Client Lifecycle State") .status-value');
        await expect(stateVal).toHaveText('CONNECTED', { timeout: 8000 });

        const terminalLogs = page.locator('.terminal-body');
        // Clear log panel or wait for active tick logging to register
        await expect(terminalLogs).toContainText('TICKS', { timeout: 5000 });

        // Navigate to Tic-Tac-Toe view (creates local subscriptions to ttt_move, ttt_reset, ttt_join)
        console.log(`[${transport}] Navigating to Tic-Tac-Toe...`);
        await page.click('li.nav-item:has-text("Tic-Tac-Toe")');
        await page.waitForTimeout(1500);

        // Navigate back to Overview (unmounts TttView, runs local cleanup)
        console.log(`[${transport}] Navigating back to Overview...`);
        await page.click('li.nav-item:has-text("Overview")');
        await page.waitForTimeout(1500);

        // Verify reference counting is intact: cleanups should NOT have dropped global ticks subscriptions!
        console.log(`[${transport}] Checking terminal logging continuity...`);
        await expect(terminalLogs).toContainText('TICKS', { timeout: 5000 });
      });

      test('should restore subscriptions cleanly after manual disconnect & reconnect recovery', async ({ page, context }) => {
        // Navigate to homepage
        await page.goto('/');

        // Set transport protocol
        const select = page.locator('select.form-select');
        await select.selectOption(transport);

        const headerStatus = page.locator('.header-status-badge span');
        await expect(headerStatus).toHaveText('connected', { timeout: 8000 });

        // Go to Tic-Tac-Toe view
        await page.click('li.nav-item:has-text("Tic-Tac-Toe")');
        await page.waitForTimeout(1000);

        // Reset board
        await page.click('button:has-text("Reset Board")');
        await page.waitForTimeout(500);

        // Join and place center mark
        await page.click('button:has-text("Join as Player X")');
        const cells = page.locator('div[style*="grid-template-columns"] button');
        await cells.nth(4).click();
        await expect(cells.nth(4)).toHaveText('X', { timeout: 3000 });

        // Simulate connection failure by going offline
        console.log(`[${transport}] Simulating offline disconnect...`);
        await context.setOffline(true);
        await expect(headerStatus).not.toHaveText('connected', { timeout: 10000 });

        // Recover connection by going online
        console.log(`[${transport}] Simulating online reconnect...`);
        await context.setOffline(false);
        await expect(headerStatus).toHaveText('connected', { timeout: 10000 });

        // Verify subscription state restoration: center cell should still show 'X' from re-poll/resubscribe sync
        await expect(cells.nth(4)).toHaveText('X', { timeout: 3000 });
      });

      test('should sync Kanban Board card moves across Leader and Follower tabs', async ({ context }) => {
        // 1. Open Tab A (will become Leader)
        const pageA = await context.newPage();
        await pageA.goto('/');

        // Wait for the app and coordinator to fully initialise before interacting.
        // The badge appears after coordinator leader-election (~100 ms), which means
        // React has mounted, all effects have run, and the Overview view (containing
        // select.form-select) is definitely in the DOM.
        const badgeA = pageA.locator('.role-dot-badge');
        await expect(badgeA).toBeVisible({ timeout: 10000 });

        // Set transport protocol
        const selectA = pageA.locator('select.form-select');
        await selectA.selectOption(transport);

        // 2. Open Tab B (will become Follower)
        const pageB = await context.newPage();
        await pageB.goto('/');

        // Wait for Tab B to be ready too
        const badgeB = pageB.locator('.role-dot-badge');
        await expect(badgeB).toBeVisible({ timeout: 10000 });

        // Set transport protocol on B
        const selectB = pageB.locator('select.form-select');
        await selectB.selectOption(transport);

        await expect(badgeA).toHaveText('LEADER', { timeout: 8000 });
        await expect(badgeB).toHaveText('FOLLOWER', { timeout: 8000 });

        // Navigate both tabs to Kanban
        await pageA.click('li.nav-item:has-text("Kanban")');
        await pageB.click('li.nav-item:has-text("Kanban")');

        // Wait for card columns to render
        const todoColumnA = pageA.locator('.kanban-column:has-text("To Do")');
        const progressColumnB = pageB.locator('.kanban-column:has-text("In Progress")');

        // Find card title "Design connection manager" in Tab A Todo column
        const cardTitle = 'Design connection manager';
        const cardA = todoColumnA.locator(`.kanban-card:has-text("${cardTitle}")`);
        await expect(cardA).toBeVisible({ timeout: 5000 });

        // Move task in Tab A to Progress
        console.log(`[${transport}] Tab A moving task to Progress...`);
        const startProgressBtn = cardA.locator('button:has-text("Start Progress ➔")');
        await startProgressBtn.click();

        // Verify the card moved into Tab B's "In Progress" column
        const cardB = progressColumnB.locator(`.kanban-card:has-text("${cardTitle}")`);
        await expect(cardB).toBeVisible({ timeout: 5000 });

        await pageA.close();
        await pageB.close();
      });

      
    });
  }
});
