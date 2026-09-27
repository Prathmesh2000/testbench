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
