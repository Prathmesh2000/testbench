import { expect, test, type Page } from '@playwright/test';

// The M1 core loop, end to end through the UI: sign in, create a case, create a run from it,
// execute it (pass one step, fail one), and see the result on Home.

const unique = Date.now().toString(36);
const title = `Verify UPI collect expiry e2e ${unique}`;

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel(/username or email/i).fill('sneha.iyer@paytrail.in');
  await page.getByRole('textbox', { name: 'Password' }).fill('Testbench@123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'My work' })).toBeVisible();
}

test('tester core loop', async ({ page }) => {
  await signIn(page);

  // Create a case with two steps.
  await page.goto('/cases');
  await page.getByRole('button', { name: 'New case' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New test case' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Labels').fill('e2e');
  await dialog.getByLabel('Step 1 action').fill('Start a UPI collect request for ₹499');
  await dialog.getByLabel('Step 1 expected result').fill('Request is PENDING');
  await dialog.getByLabel('Step 1 expected result').press('Enter');
  await dialog.getByLabel('Step 2 action').fill('Wait 5 minutes');
  await dialog.getByLabel('Step 2 expected result').fill('Request is EXPIRED');
  await dialog.getByRole('button', { name: 'Create case' }).click();
  await expect(page.getByRole('status').filter({ hasText: /created in/ })).toBeVisible();
  const drawer = page.getByRole('complementary', { name: /^Case TC-/ });
  const caseKey = (await drawer.getAttribute('aria-label'))!.replace('Case ', '');

  // Create a run from exactly that case.
  await page.getByLabel('Search cases').fill(caseKey);
  await expect(page.getByRole('row', { name: new RegExp(caseKey) })).toBeVisible();
  await page.getByLabel(`Select ${caseKey}`).check();
  await page.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Create run' }).click();
  await expect(page.getByText(/Using the 1 cases you selected/)).toBeVisible();
  await page.getByLabel('Run name').fill(`E2E run ${unique}`);
  await page.getByLabel('Build').fill('8812');
  await page.getByText('Sneha Iyer').click();
  await page.getByRole('button', { name: /Create run with 1 items/ }).click();

  // Execute: pass step 1 with the keyboard, fail step 2 with an actual result.
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.locator('body').press('p');
  // The active step moves on to step 2, which hides step 1's buttons, hence includeHidden.
  await expect(page.getByRole('button', { name: 'Passed step 1', includeHidden: true })).toHaveClass(/on/);
  await page.getByRole('button', { name: 'Failed step 2' }).click();
  await page.getByLabel(/Actual result/).fill('Request stayed PENDING after 6 minutes');
  await page.getByLabel(/Actual result/).press('Enter');
  await expect(page.getByRole('region', { name: 'Current case' }).getByText('Failed').first()).toBeVisible();
  await expect(page.getByText('1 / 1 done')).toBeVisible();

  // Home shows the run's progress.
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(`E2E run ${unique}`) })).toBeVisible();
});

// M2: search a case with TQL, fail it, log the bug to Jira, have "the developer" fix it in the Jira
// sandbox (its signed webhook reaches core-api), then retest it from the Defects retest queue.
test('search, log bug, fix in Jira, retest', async ({ page, request }) => {
  const title = `Verify wallet top-up limit e2e ${unique}`;
  await signIn(page);

  await page.goto('/cases?new=1');
  const dialog = page.getByRole('dialog', { name: 'New test case' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Step 1 action').fill('Top up the wallet with ₹2,00,001');
  await dialog.getByLabel('Step 1 expected result').fill('Top-up is refused above the KYC limit');
  await dialog.getByRole('button', { name: 'Create case' }).click();
  const caseKey = (await page.getByRole('complementary', { name: /^Case TC-/ }).getAttribute('aria-label'))!.replace('Case ', '');

  // TQL search finds it once the indexer has caught up.
  await expect(async () => {
    await page.goto(`/search?q=${encodeURIComponent(`key = ${caseKey}`)}`);
    await expect(page.getByRole('link', { name: new RegExp(caseKey) })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Create run from results' }).click();
  await page.getByLabel('Run name').fill(`E2E defect run ${unique}`);
  await page.getByLabel('Build').fill('8812');
  await page.getByText('Sneha Iyer').click();
  await page.getByRole('button', { name: /Create run with 1 items/ }).click();

  await page.getByRole('button', { name: 'Failed step 1' }).click();
  await page.getByLabel(/Actual result/).fill('Top-up of ₹2,00,001 went through');
  await page.getByLabel(/Actual result/).press('Enter');
  await page.locator('body').press('Control+Shift+B');
  const bug = page.getByRole('dialog', { name: 'Log bug' });
  await bug.getByLabel('Summary').fill(`Wallet top-up above the KYC limit is accepted ${unique}`);
  await bug.getByRole('button', { name: 'Create in Jira' }).click();
  const toast = page.getByRole('status').filter({ hasText: /created in Jira/ });
  await expect(toast).toBeVisible();
  const jiraKey = (await toast.textContent())!.match(/[A-Z]+-\d+/)![0];

  // The developer marks it Done in Jira; the sandbox sends a signed webhook to core-api.
  const auth = { Authorization: `Basic ${Buffer.from('qa@paytrail.in:jira-sandbox-token').toString('base64')}` };
  await request.post(`http://localhost:8090/rest/api/3/issue/${jiraKey}/transitions`, { headers: auth, data: { transition: { id: '41' } } });

  await page.goto('/defects');
  await page.getByRole('tab', { name: /Retest queue/ }).click();
  await expect(async () => {
    await page.reload();
    await page.getByRole('tab', { name: /Retest queue/ }).click();
    await expect(page.getByRole('row', { name: new RegExp(jiraKey) })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole('row', { name: new RegExp(jiraKey) }).click();
  await page.getByRole('button', { name: 'Passed' }).click();
  await page.getByLabel('Build you retested on').fill('8815');
  await page.getByRole('button', { name: 'Record retest' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Verified/ })).toBeVisible();

  const issue = await (await request.get(`http://localhost:8090/rest/api/3/issue/${jiraKey}`, { headers: auth })).json();
  expect(JSON.stringify(issue.fields.comment)).toContain('passes on build 8815');
});
