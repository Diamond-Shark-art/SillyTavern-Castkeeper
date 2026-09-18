import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.goto('/tests/browser/harness.html');
    await page.waitForFunction(() => window.ready);
    await page.getByRole('button', { name: 'Castkeeper', exact: true }).click();
});

async function scan(page) {
    await page.getByRole('button', { name: 'Scan recent messages' }).click();
    await expect(page.getByRole('button', { name: /Mira human/ })).toBeVisible();
    await page.getByRole('button', { name: /Mira human/ }).click();
}

test('scan, edit, lock and safely render profile text', async ({ page }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await scan(page);
    await expect(page.getByLabel('Species', { exact: true })).toHaveValue('human');
    await expect(page.getByLabel('Short backstory', { exact: true })).toHaveValue('');
    await page.getByLabel('Short backstory', { exact: true }).fill('<img src=x onerror="window.injected=true"> A former sailor.');
    await expect(page.getByLabel('Lock Short backstory', { exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.locator('.npc-provenance[data-provenance="edited"]')).toHaveCount(1);
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await page.getByLabel('Short backstory', { exact: true }).fill('Mira once tended the gardens of a coastal inn. She now runs a quiet tavern for travelers.');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await page.locator('.npc-editor').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: `test-results/${testInfo.project.name}-profile.png`, fullPage: true });
    const overflow = await page.locator('.npc-profiles-dialog').evaluate(node => node.scrollWidth > node.clientWidth + 1);
    expect(overflow).toBe(false); expect(errors).toEqual([]);
});

test('creative completion is preview-only and applies edited selections', async ({ page }) => {
    await scan(page);
    await page.getByRole('button', { name: 'Generate missing details' }).click();
    await expect(page.getByRole('heading', { name: 'Review suggested details' })).toBeVisible();
    await expect(page.getByLabel('Short backstory', { exact: true })).toHaveValue('');
    await page.getByLabel('Suggested Short backstory', { exact: true }).fill('Mira is a former shipwright.');
    await page.getByRole('button', { name: 'Apply selected suggestions' }).click();
    await expect(page.getByLabel('Short backstory', { exact: true })).toHaveValue('Mira is a former shipwright.');
    await expect(page.getByLabel('Lock Short backstory', { exact: true })).toBeChecked();
    await expect(page.getByLabel('Race / ancestry', { exact: true })).toHaveValue('Coastal ancestry');
});

test('manual creation, searching, deletion and per-chat isolation', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: '+ New profile' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Ember');
    await page.getByLabel('Species', { exact: true }).fill('dragon');
    await page.getByLabel('Skin / covering color', { exact: true }).fill('Silver scales');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ember', exact: true })).toBeVisible();
    if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'All profiles' }).click();
    await page.getByRole('searchbox').fill('Silver');
    await expect(page.getByRole('button', { name: /Ember dragon/ })).toBeVisible();
    await page.getByRole('button', { name: /Ember dragon/ }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete profile' }).click();
    await expect(page.getByRole('button', { name: /Ember dragon/ })).toHaveCount(0);
    await page.evaluate(async () => { host.chatId = 'new-story'; host.chatMetadata = {}; await host.eventSource.emit('CHAT_CHANGED'); });
    await expect(page.locator('.npc-list')).not.toContainText('Ember');
});

test('malformed model output offers retry and never creates a partial profile', async ({ page }) => {
    await page.evaluate(() => { host.respond = async () => 'This is not JSON'; });
    await page.getByRole('button', { name: 'Scan recent messages' }).click();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(page.locator('.npc-cast-card')).toHaveCount(0);
    await page.evaluate(async () => { const { npc, response } = await import('/tests/fixtures.js'); host.respond = async () => JSON.stringify(response(npc())); });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('button', { name: /Mira human/ })).toBeVisible();
});

test('automatic lifecycle events create one profile without posting a visible message', async ({ page }) => {
    await page.evaluate(async () => {
        await host.eventSource.emit('MESSAGE_RECEIVED', 1, 'normal');
        await host.eventSource.emit('CHARACTER_MESSAGE_RENDERED', 1, 'normal');
    });
    await expect(page.getByRole('button', { name: /Mira human/ })).toBeVisible();
    expect(await page.evaluate(() => host.calls.length)).toBe(1);
    expect(await page.evaluate(() => host.chat.length)).toBe(2);
});
