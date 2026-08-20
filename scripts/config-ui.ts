// ─────────────────────────────────────────────────────────────
// The room type editor, driven in a real browser.
//
//   node scripts/config-ui.ts   (API, app and Chrome with --remote-debugging-port must be up)
//
// The defect this exists for: the list showed "16 beds (2 × 8)" and the Edit
// dialog had no field that could change it. Two screens describing one room
// type, with the number only readable on one of them — so the check is that
// every count on the card is editable from the dialog the card opens.
//
// It reads and opens dialogs. It does not save, so nothing is written.
// ─────────────────────────────────────────────────────────────
import { Cdp, openApp, waitFor, sleep, APP, CDP_URL } from './lib/cdp.ts';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) {
    failures++;
    if (detail !== undefined) {
      process.stdout.write(`      ${String(JSON.stringify(detail)).slice(0, 300)}\n`);
    }
  }
}
function section(title: string) {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
}

/**
 * Click the button whose text matches, inside the card naming `roomType`.
 *
 * "The deepest div containing the name" is the wrong element — that is the
 * heading, which holds no buttons. What is wanted is the *smallest* div that
 * contains both the name and the button, which is the card itself.
 */
function clickOnCard(cdp: Cdp, roomType: string, label: string) {
  return cdp.evaluate<boolean>(`(() => {
    const wanted = ${JSON.stringify(roomType)};
    const label = ${JSON.stringify(label)};
    const cards = [...document.querySelectorAll('div')].filter((d) => {
      if (!(d.textContent || '').includes(wanted)) return false;
      return [...d.querySelectorAll('button')]
        .some((b) => (b.textContent || '').trim() === label);
    });
    // Smallest such container = the card, not the page.
    const card = cards.sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!card) return false;
    const b = [...card.querySelectorAll('button')]
      .find((x) => (x.textContent || '').trim() === label);
    if (!b) return false;
    b.click();
    return true;
  })()`);
}

const dialogText = (cdp: Cdp) => cdp.evaluate<string>(`(() => {
  const d = [...document.querySelectorAll('div')].find(
    x => (x.textContent || '').startsWith('Edit ') && x.querySelector('input'));
  return d ? d.innerText : '(no dialog)';
})()`);

async function main() {
  process.stdout.write(`\nRoom type editor UI checks · ${APP}\n${'─'.repeat(40)}\n`);
  const { cdp, consoleErrors, targetId } = await openApp({ path: '/config' });

  try {
    await waitFor(cdp, /Configuration/i);
    await cdp.evaluate(`(() => {
      const t = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Room types');
      if (t) t.click();
      return !!t;
    })()`);
    await sleep(1200);

    section('1 · The card shows both sides');
    const page = await cdp.evaluate<string>('document.body.innerText');
    check('Helio’s own count is shown', /Helio \d+ (beds|rooms)/.test(page),
      page.match(/Helio \d+ \w+[^\n]*/)?.[0]);
    check('…with the room × bed breakdown for a dorm',
      /\(\d+ × \d+\)/.test(page), page.match(/\(\d+ × \d+\)/)?.[0]);
    check('…and what the channel holds',
      /channel agrees · \d+|channel says \d+/.test(page),
      page.match(/channel [^\n]*/)?.[0]);

    section('2 · Edit can change every number the card shows');
    const opened = await clickOnCard(cdp, 'Bed in 8-Bed Mixed Dormitory Room', 'Edit');
    check('the Edit button opens a dialog', opened);
    await sleep(700);

    let text = await dialogText(cdp);
    check('the dialog is for the right room type',
      /Bed in 8-Bed Mixed Dormitory Room/.test(text), text.slice(0, 80));
    // The whole point: the count is editable here, not on a second screen.
    check('it has a rooms field', /Rooms of this type|How many rooms/i.test(text), text.slice(0, 400));
    check('…and a beds-per-room field for a dorm', /Beds in each room/i.test(text));
    check('…and says what the result will be for sale',
      /\d+ (beds|rooms) for sale/i.test(text), text.match(/[^\n]*for sale[^\n]*/)?.[0]);
    check('…and what the channel currently sells',
      /The channel sells \d+/.test(text), text.match(/The channel sells[^\n]*/)?.[0]);
    check('the auto-send switch is offered',
      /Send count changes to the channel automatically/i.test(text));

    // The attributes are still there — folding inventory in must not have
    // pushed anything else out.
    for (const field of ['Code', 'Name', 'Kind', 'Base occupancy', 'Default rate', 'Amenities']) {
      check(`“${field}” is still in the dialog`,
        new RegExp(field, 'i').test(text), field);
    }

    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Cancel');
      if (b) b.click(); return true;
    })()`);
    await sleep(500);

    section('3 · "Change count" opens the same dialog');
    // Two entry points, one editor — the previous split was the fault.
    const viaCount = await clickOnCard(cdp, 'Bed in 8-Bed Mixed Dormitory Room', 'Change count');
    check('the Change count button works', viaCount);
    await sleep(700);
    text = await dialogText(cdp);
    check('…and lands in the full editor, not a stub',
      /Bed in 8-Bed Mixed Dormitory Room/.test(text) && /Code/i.test(text)
      && /Rooms of this type/i.test(text), text.slice(0, 200));

    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Cancel');
      if (b) b.click(); return true;
    })()`);

    section('4 · Nothing threw');
    const real = consoleErrors.filter((e) => !/favicon|manifest|sw\.js/i.test(e));
    check('no console errors', real.length === 0, real.slice(0, 3));

    process.stdout.write(`\n${checks - failures}/${checks} room type editor checks passed\n`);
    if (!failures) process.stdout.write('One dialog holds everything the card shows.\n');
  } finally {
    cdp.close();
    try { await fetch(`${CDP_URL}/json/close/${targetId}`); } catch { /* tab gone */ }
  }
  if (failures) process.exitCode = 1;
}

await main().catch((e) => {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.message : String(e)}\n`);
  process.stderr.write('Chrome must be running with --remote-debugging-port=9222,\n'
    + 'and the API and app must be up.\n');
  process.exitCode = 1;
});
