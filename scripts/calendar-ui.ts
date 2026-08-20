// ─────────────────────────────────────────────────────────────
// Drives the real tape chart in a real browser.
//
//   node scripts/calendar-ui.ts   (API, app and Chrome with --remote-debugging-port must be up)
//
// `tapechart-check.ts` proves the stitching arithmetic. This proves the screen
// built on it actually works, which is a different question and not one unit
// tests can answer:
//
//   · does scrolling right load more time, rather than hitting a wall?
//   · does scrolling *left* keep the view still, or does the chart lurch away
//     when a chunk is prepended? This is the defect that makes infinite
//     scrollers unpleasant, and it is invisible to any test that does not
//     measure the viewport before and after.
//   · is the grid actually virtualised, or is it rendering a year of columns?
//   · do the filters change what is drawn, and say so when they hide rooms?
//
// It only reads and scrolls. Nothing here writes to the database.
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
      process.stdout.write(`      ${String(JSON.stringify(detail)).slice(0, 400)}\n`);
    }
  }
}
function section(title: string) {
  process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
}

// The chart's horizontal scroller, by an explicit hook rather than by guessing
// which element overflows. The guess used to pick the toolbar once it wrapped,
// and the resulting failures pointed at the scrolling code rather than at the
// selector — a test that lies about *where* the fault is costs more than one
// that simply fails.
const SCROLLER = `document.querySelector('[data-testid="tape-scroller"]')`;

async function metrics(cdp: Cdp) {
  return cdp.evaluate<{ left: number; width: number; client: number; cols: number; bars: number }>(`(() => {
    const el = ${SCROLLER};
    if (!el) return { left: -1, width: -1, client: -1, cols: -1, bars: -1 };
    return {
      left: Math.round(el.scrollLeft),
      width: Math.round(el.scrollWidth),
      client: Math.round(el.clientWidth),
      // Day columns in **one** lane. Counting them across the whole grid says
      // nothing — it scales with the number of rooms, not the number of days,
      // so a perfectly virtualised chart with 35 lanes still reports a big
      // number. One lane's column count is the actual signal.
      cols: (() => {
        const lane = el.querySelector('[class*="border-l"]')?.parentElement;
        return lane ? lane.querySelectorAll('[class*="border-l"]').length : -1;
      })(),
      bars: el.querySelectorAll('button[title*="→"]').length,
    };
  })()`);
}

async function scrollBy(cdp: Cdp, dx: number) {
  await cdp.evaluate(`(() => { const el = ${SCROLLER}; if (el) el.scrollLeft += ${dx}; true; })()`);
  await sleep(700);   // let the extension fetch and the layout effect settle
}

async function main() {
  process.stdout.write(`\nTape chart UI checks · ${APP}\n${'─'.repeat(40)}\n`);

  const { cdp, consoleErrors, targetId } = await openApp({ path: '/calendar' });

  try {
    // The chart remembers filters, density and folded groups between sessions,
    // which is right for a receptionist and wrong for a test: a previous run
    // would leave this one starting from a filtered, zoomed, half-folded chart
    // and failing for reasons that have nothing to do with the code.
    await cdp.evaluate(`(() => { localStorage.removeItem('helio.tape.prefs.v1'); true; })()`);
    await cdp.send('Page.reload');
    await sleep(1500);
    await cdp.evaluate(`(() => { window.location.hash = '/calendar'; true; })()`);

    await waitFor(cdp, /Tape chart/i);
    await sleep(1500);   // the first chunks land

    section('1 · It renders');
    const first = await metrics(cdp);
    check('the horizontal scroller exists', first.client > 0, first);
    check('…and is much wider than the viewport', first.width > first.client * 2, first);

    const text = await cdp.evaluate<string>('document.body.innerText');
    check('sellable units are counted', /sellable unit/i.test(text), text.slice(0, 200));
    check('the scroll hint is shown', /scroll sideways for more/i.test(text));

    section('2 · Virtualisation');
    // 180 days are loaded at the start. A lane rendering all of them is not
    // virtualised; a lane rendering roughly a screenful plus overscan is.
    const daysLoaded = Math.round(first.width / 46);
    check('a lane renders far fewer columns than the days loaded',
      first.cols > 0 && first.cols < daysLoaded * 0.6, { cols: first.cols, daysLoaded });
    check('…but enough to cover the viewport',
      first.cols >= Math.floor(first.client / 46), { cols: first.cols, client: first.client });

    section('3 · Scrolling right loads more time');
    const beforeRight = await metrics(cdp);
    await scrollBy(cdp, beforeRight.width - beforeRight.client - beforeRight.left - 50);
    await sleep(900);
    const afterRight = await metrics(cdp);
    check('the scrollable width grew — the future was fetched',
      afterRight.width > beforeRight.width, { before: beforeRight.width, after: afterRight.width });
    check('…and the view actually moved', afterRight.left > beforeRight.left,
      { before: beforeRight.left, after: afterRight.left });

    section('4 · Scrolling left does not lurch');
    // The one that matters. Go to the very start, which forces a prepend, and
    // check the content under the viewport stayed put: after prepending a
    // chunk, scrollLeft must have been corrected by exactly the inserted width,
    // so the width grows and the position grows with it.
    await cdp.evaluate(`(() => { const el = ${SCROLLER}; if (el) el.scrollLeft = 0; true; })()`);
    await sleep(1200);
    const afterLeft = await metrics(cdp);
    check('the past was fetched too', afterLeft.width > afterRight.width,
      { before: afterRight.width, after: afterLeft.width });
    check('…and the view was pushed off the left edge, not left stuck at 0',
      afterLeft.left > 0, afterLeft);
    // If the correction were missing, scrollLeft would still read 0 and the
    // user would be looking at a different month than the one they scrolled to.
    const grew = afterLeft.width - afterRight.width;
    check('the correction matches the width inserted',
      Math.abs(afterLeft.left - grew) < 5, { shift: afterLeft.left, inserted: grew });

    section('5 · Today');
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Today');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(1200);
    const atToday = await metrics(cdp);
    check('the Today control moves the view', atToday.left !== afterLeft.left,
      { before: afterLeft.left, after: atToday.left });

    section('6 · Filters');
    const opened = await cdp.evaluate<boolean>(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^Filters/.test(x.textContent.trim()));
      if (b) b.click();
      return !!b;
    })()`);
    check('the filter panel opens', opened);
    await sleep(400);

    const lanesBefore = await cdp.evaluate<number>(
      `document.body.innerText.match(/(\\d+) sellable unit/) ?
        Number(document.body.innerText.match(/(\\d+) sellable unit/)[1]) : -1`);

    // Pick the first room-type chip and apply it.
    const applied = await cdp.evaluate<boolean>(`(() => {
      const heads = [...document.querySelectorAll('p')];
      const h = heads.find(p => p.textContent.trim() === 'Room type');
      if (!h) return false;
      const chip = h.parentElement.querySelector('button');
      if (!chip) return false;
      chip.click();
      return true;
    })()`);
    check('a room type filter can be applied', applied);
    await sleep(700);

    const afterFilter = await cdp.evaluate<string>('document.body.innerText');
    const lanesAfter = Number(afterFilter.match(/(\d+) sellable unit/)?.[1] ?? -1);
    check('the lane count changed', lanesAfter !== lanesBefore && lanesAfter >= 0,
      { before: lanesBefore, after: lanesAfter });
    // A chart that silently omits rooms is how one gets sold twice.
    check('…and the screen says how many rooms are hidden',
      /hidden/i.test(afterFilter), afterFilter.slice(0, 300));

    const cleared = await cdp.evaluate<boolean>(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /Clear all filters/i.test(x.textContent));
      if (b) b.click();
      return !!b;
    })()`);
    check('filters can be cleared again', cleared);
    await sleep(600);
    const restored = Number(
      (await cdp.evaluate<string>('document.body.innerText')).match(/(\d+) sellable unit/)?.[1] ?? -1);
    check('…and every lane comes back', restored === lanesBefore, { restored, expected: lanesBefore });

    section('7 · Search');
    await cdp.evaluate(`(() => {
      const i = document.querySelector('input[placeholder*="Find a guest"]');
      if (!i) return false;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
        .set.call(i, 'zzzz-no-such-guest');
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const searched = await metrics(cdp);
    // Search dims rather than hides — the lanes must still be there.
    const stillThere = Number(
      (await cdp.evaluate<string>('document.body.innerText')).match(/(\d+) sellable unit/)?.[1] ?? -1);
    check('a search that matches nothing still shows every room',
      stillThere === lanesBefore, { stillThere, expected: lanesBefore });
    check('…and the chart is still scrollable', searched.width > searched.client);

    section('8 · Zoom keeps its place');
    await cdp.evaluate(`(() => {
      const i = document.querySelector('input[placeholder*="Find a guest"]');
      if (i) {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, '');
        i.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`);
    await sleep(400);
    const beforeZoom = await metrics(cdp);
    const dayBefore = beforeZoom.left / 46;
    const zoomed = await cdp.evaluate<boolean>(`(() => {
      const sel = [...document.querySelectorAll('select')]
        .find(s => [...s.options].some(o => /Compact/.test(o.textContent)));
      if (!sel) return false;
      const opt = [...sel.options].find(o => /Compact/.test(o.textContent));
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')
        .set.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    check('the density control is there', zoomed);
    await sleep(800);
    const afterZoom = await metrics(cdp);
    const dayAfter = afterZoom.left / 30;
    // Same date at the left edge, not the same pixel — that is the whole point.
    check('zooming keeps the same date at the left edge',
      Math.abs(dayAfter - dayBefore) < 3, { dayBefore, dayAfter });

    section('9 · Grouping folds away');
    const groupsBefore = await cdp.evaluate<number>(
      `document.querySelectorAll('button[title^="Hide "]').length`);
    check('groups have headers you can fold', groupsBefore > 0, groupsBefore);
    const lanesOpen = await cdp.evaluate<number>('document.querySelectorAll(\'[class*="border-l"]\').length');
    await cdp.evaluate(`(() => {
      const b = document.querySelector('button[title^="Hide "]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(500);
    const lanesFolded = await cdp.evaluate<number>('document.querySelectorAll(\'[class*="border-l"]\').length');
    check('folding a group removes its lanes', lanesFolded < lanesOpen, { lanesOpen, lanesFolded });
    const stillHeader = await cdp.evaluate<number>(
      `document.querySelectorAll('button[title^="Show "]').length`);
    // A folded group with no header could never be reopened.
    check('…but keeps a header to unfold it with', stillHeader > 0, stillHeader);
    await cdp.evaluate(`(() => {
      const b = document.querySelector('button[title^="Show "]');
      if (b) b.click();
      return true;
    })()`);
    await sleep(500);
    check('unfolding brings the lanes back',
      (await cdp.evaluate<number>('document.querySelectorAll(\'[class*="border-l"]\').length')) === lanesOpen);

    section('10 · The room names stay put');
    // The defect this exists for: the label column used to live inside the
    // scrolling area, so scrolling to January took the room numbers with it and
    // the chart read as empty rather than as scrolled. Measuring the label's
    // position on screen before and after a scroll is the only way to see it —
    // the lanes are all still in the DOM either way.
    const labelAt = () => cdp.evaluate<{ x: number; text: string; view: number }>(`(() => {
      const el = ${SCROLLER};
      const spans = [...el.querySelectorAll('span')];
      const lane = spans.find(s => /^[A-Z]{3,}/.test((s.textContent || '').trim()));
      const r = lane ? lane.getBoundingClientRect() : null;
      return {
        x: r ? Math.round(r.left) : -9999,
        text: lane ? lane.textContent.trim() : '(none)',
        view: Math.round(el.getBoundingClientRect().left),
      };
    })()`);

    const before = await labelAt();
    check('a room label is on screen to begin with',
      before.x >= before.view - 2, before);
    await scrollBy(cdp, 1500);
    const after = await labelAt();
    check('…and is still in the same place after scrolling',
      Math.abs(after.x - before.x) < 3, { before: before.x, after: after.x });
    check('…and is the same label, not a different row',
      after.text === before.text, { before: before.text, after: after.text });

    section('11 · Dorms and rooms are separated');
    const page = await cdp.evaluate<string>('document.body.innerText');
    check('dormitory beds have their own banner', /Dormitory beds/i.test(page));
    check('private rooms have their own banner', /Private rooms/i.test(page));
    check('each banner carries its own totals',
      /\d+\/\d+ sold tonight/.test(page), page.match(/.{0,40}sold tonight.{0,20}/)?.[0]);
    // Dorms first, because they are the part that needs watching bed by bed.
    check('dorms are drawn before private rooms',
      page.indexOf('Dormitory beds') < page.indexOf('Private rooms'),
      { dorm: page.indexOf('Dormitory beds'), room: page.indexOf('Private rooms') });
    check('a dorm lane says which bed of how many it is',
      /bed \d+\/\d+/.test(page), page.match(/.{0,30}bed \d+\/\d+.{0,24}/)?.[0]);
    check('…and which bunk', /bed \d+\/\d+ · (top|bottom|single)/.test(page));
    check('the month being viewed is stated',
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/
        .test(page));

    section('12 · Nothing threw');
    const real = consoleErrors.filter((e) => !/favicon|manifest|sw\.js/i.test(e));
    check('no console errors while driving the screen', real.length === 0, real.slice(0, 3));

    process.stdout.write(`\n${checks - failures}/${checks} tape chart UI checks passed\n`);
    if (!failures) {
      process.stdout.write('The chart scrolls without end and without losing your place.\n');
    }
  } finally {
    cdp.close();
    try { await fetch(`${CDP_URL}/json/close/${targetId}`); } catch { /* tab already gone */ }
  }
  if (failures) process.exitCode = 1;
}

await main().catch((e) => {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.message : String(e)}\n`);
  process.stderr.write('Chrome must be running with --remote-debugging-port=9222,\n'
    + 'and the API and app must be up.\n');
  process.exitCode = 1;
});
