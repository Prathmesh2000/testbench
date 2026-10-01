import { chromium, type Page } from 'playwright';
const flat = (s: string) => s.replace(/\s*\n\s*/g, ' | ');
const shot = (p: Page, n: string) => p.screenshot({ path: `/tmp/walk-${n}.png` });
let P: Page;
// A click at a point of the site under test, through the streamed picture as a tester's mouse would.
async function site(x: number, y: number) {
  const img = P.locator('img[draggable=false]').first();
  const box = (await img.boundingBox())!;
  const [nw, nh] = await img.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]);
  const s = Math.min(box.width / nw, box.height / nh);
  await P.mouse.click(box.x + (box.width - nw * s) / 2 + x * s, box.y + (box.height - nh * s) / 2 + y * s);
  await P.waitForTimeout(700);
}
const typeIn = async (t: string) => { await P.keyboard.type(t, { delay: 40 }); await P.waitForTimeout(500); };
const guideText = async () => flat(await P.locator('aside[aria-label=Guide]').innerText()).slice(0, 1400);
(async () => {
  const b = await chromium.launch();
  P = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const p = P;
  await p.goto('http://localhost:3000/auth/login?returnTo=/automation?tab=workflows');
  await p.fill('input[name=username]', 'sneha.iyer@paytrail.in');
  await p.fill('input[name=password]', 'Testbench@123');
  await p.click('[type=submit]');
  await p.waitForURL(/automation/, { timeout: 30000 });
  await p.evaluate(() => localStorage.setItem('tb.project', 'a9086e15-59b8-402c-80f2-6201304d4c39'));
  await p.goto('http://localhost:3000/automation?tab=workflows&new=1');
  const g = p.locator('aside[aria-label=Guide]');
  await g.getByText('What must be true').waitFor({ timeout: 30000 });
  console.log('STEP1:', await guideText());
  await g.getByPlaceholder('Signed in as an admin').fill('signed in');
  await p.waitForTimeout(1500);
  await g.getByText('Signed in to the projects app').first().click();
  await p.waitForTimeout(800);
  console.log('STEP1 picked:', await guideText());
  await shot(p, '1');
  const siteBox = g.getByPlaceholder('https://staging.example.com');
  console.log('STEP1 site field:', JSON.stringify(await siteBox.inputValue()));
  if (!(await siteBox.inputValue())) await siteBox.fill('http://localhost:4555');
  await g.getByRole('button', { name: 'Open the site first' }).click();
  await g.getByRole('button', { name: /^Run it$/ }).waitFor({ timeout: 60000 });
  await g.getByRole('button', { name: /^Run it$/ }).click();
  await g.getByText(/Done · now on|Stopped/).waitFor({ timeout: 60000 });
  console.log('STEP1 run:', await g.getByText(/Done · now on|Stopped/).innerText());
  await g.getByRole('button', { name: /Next/ }).click();
  await g.getByPlaceholder('Create a project').fill('Create a priority project');
  await g.getByPlaceholder(/Create a new project from/).fill('Create a project with High priority from the Projects page and open it');
  await g.getByRole('button', { name: /Next/ }).click();
  console.log('STEP3:', await guideText());
  await g.getByRole('button', { name: /Record the workflow/ }).click();
  await p.waitForTimeout(1200);
  await site(70, 95);            // Add New Project
  await site(100, 155); await typeIn('Echo Plan');
  await site(380, 255); await typeIn('EP1');
  await site(340, 215);           // Priority select
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
  await p.waitForTimeout(800);
  await shot(p, '3-filled');
  await site(70, 255);            // Add
  await p.waitForTimeout(2000);
  await site(60, 318);            // open the new project
  await p.waitForTimeout(2000);
  await g.getByRole('button', { name: 'Stop recording' }).click();
  await p.waitForTimeout(1500);
  console.log('STEP3 after stop:', await guideText());
  await g.getByRole('button', { name: /Review it/ }).click();
  await g.getByRole('button', { name: /Review it|Reading the recording/ }).waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(1000);
  console.log('STEP4 review:', await guideText());
  await shot(p, '4-review');
  const apply = g.getByRole('button', { name: 'Apply answers' });
  if (await apply.count()) {
    const radios = g.locator('fieldset input[type=radio]');
    if (await radios.count()) await radios.first().check();
    if (await apply.isEnabled()) { await apply.click(); await p.waitForTimeout(4000); console.log('STEP4 applied:', await guideText()); }
  }
  await g.getByRole('button', { name: 'Save workflow' }).click();
  await p.waitForTimeout(4000);
  console.log('AFTER SAVE url:', p.url());
  console.log('AFTER SAVE:', await guideText());
  await shot(p, '5-saved');
  await b.close();
})().catch(async (e) => {
  console.error('FAIL', e.message.slice(0, 700));
  await P?.screenshot({ path: '/tmp/walk-fail.png' }).catch(() => {});
  console.error('GUIDE:', await guideText().catch(() => ''));
  process.exit(1);
});
