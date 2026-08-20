// ─────────────────────────────────────────────────────────────
// Exercises guest messaging through a channel: polling conversations in,
// sending replies out, the inbox, and templates.
//
//   node --experimental-sqlite scripts/messaging-check.ts
//
// Runs against a stub that speaks the documented Beds24 protocol. The cases
// that matter most are the ones where a message does *not* get through:
//
//   · a channel that does not carry guest messages at all;
//   · a 200 whose body says the message was rejected;
//   · a booking with no channel behind it.
//
// In every one of those, the reply has to stay visible on the thread and be
// labelled as not sent. A messaging screen that loses a typed reply, or shows
// it as delivered when nobody received it, is worse than no messaging screen.
//
// It builds its own database in a temp directory; the live one is never opened.
// ─────────────────────────────────────────────────────────────
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const workdir = mkdtempSync(join(tmpdir(), 'helio-msg-'));
process.env.HELIO_DB = join(workdir, 'data', 'helio.db');
process.env.HELIO_BACKUP_ENABLED = 'false';

type Mode = 'ok' | 'item-error' | 'http-error';
let mode: Mode = 'ok';
let inboundMessages: any[] = [];
const sent: any[] = [];

function startStub(): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.url?.startsWith('/authentication/token')) {
          return send(200, { token: 'stub-token', expiresIn: 3600 });
        }
        if (req.url?.startsWith('/bookings/messages')) {
          if (req.method === 'POST') {
            sent.push(JSON.parse(raw));
            if (mode === 'http-error') return send(502, { error: 'Bad gateway' });
            if (mode === 'item-error') {
              return send(200, { success: true, data: [{ success: false, errors: [{ error: 'Messaging is closed for this booking' }] }] });
            }
            return send(200, { success: true, data: [{ success: true, id: 7 }] });
          }
          return send(200, { success: true, data: inboundMessages });
        }
        send(404, { error: 'not found' });
      });
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, base: `http://localhost:${port}` });
    });
  });
}

const stub = await startStub();
process.env.BEDS24_API = stub.base;

const { migrate, run, get, all } = await import('../src/db.ts');
const { id, nowIso, addDays } = await import('../src/lib/util.ts');
const msg = await import('../src/services/messaging.ts');
const { CATALOGUE } = await import('../src/routes/channels.ts');

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) {
    failures++;
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 300)}\n`);
  }
}
function section(t: string) { process.stdout.write(`\n${t}\n${'─'.repeat(t.length)}\n`); }

const ACTOR = { userId: 'usr_test', userName: 'Reception', propertyId: '' };
const TODAY = '2026-06-05';

function seed() {
  const propertyId = id('prp');
  run(
    `INSERT INTO properties(id, code, name, kind, timezone, currency, locale, business_date,
                            check_in_time, check_out_time, active, created_at)
     VALUES(?,?,?,'hotel','UTC','USD','en',?,'14:00','11:00',1,?)`,
    propertyId, 'MSG', 'Message Test Hotel', TODAY, nowIso(),
  );
  const roomTypeId = id('rt');
  run(
    `INSERT INTO room_types(id, property_id, code, name, kind, base_occupancy, max_occupancy,
                            max_adults, max_children, default_rate_minor, extra_adult_minor,
                            extra_child_minor, sort_order, active, created_at)
     VALUES(?,?,'DLX','Deluxe King','room',2,2,2,0,20000,0,0,1,1,?)`,
    roomTypeId, propertyId, nowIso(),
  );
  const ratePlanId = id('rp');
  run(
    `INSERT INTO rate_plans(id, property_id, code, name, active, created_at)
     VALUES(?,?,'BAR','Best Available',1,?)`,
    ratePlanId, propertyId, nowIso(),
  );
  const roomId = id('rm');
  run(
    `INSERT INTO rooms(id, property_id, room_type_id, number, floor, status, active, created_at)
     VALUES(?,?,?,'402',4,'Vacant Clean',1,?)`,
    roomId, propertyId, roomTypeId, nowIso(),
  );
  // One channel that carries messages, one that does not.
  for (const [code, name] of [['BDC', 'Booking.com'], ['HW', 'Hostelworld']] as const) {
    run(
      `INSERT INTO channels(id, property_id, code, name, kind, active, status, settings, created_at)
       VALUES(?,?,?,?,'ota',1,'connected',?,?)`,
      id('chn'), propertyId, code, name,
      JSON.stringify({ credentials: { refreshToken: 'stub-refresh' } }), nowIso(),
    );
  }
  return { propertyId, roomTypeId, ratePlanId, roomId };
}

let seq = 0;
function booking(ctx: any, opts: {
  channelCode?: string | null; otaReference?: string | null;
  status?: string; arrival?: string; guest?: string; roomId?: string | null;
} = {}) {
  const resId = id('res');
  seq++;
  const arrival = opts.arrival ?? TODAY;
  run(
    `INSERT INTO reservations(id, property_id, confirmation, status, guest_name, arrival, departure,
                              nights, adults, children, room_type_id, room_id, rate_plan_id, currency,
                              total_minor, deposit_required_minor, commission_minor, source, origin,
                              channel_code, ota_reference, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,2,2,0,?,?,?,'USD',40000,0,0,'OTA','channel',?,?,?,?)`,
    resId, ctx.propertyId, `MSG-${String(seq).padStart(4, '0')}`,
    opts.status ?? 'Confirmed', opts.guest ?? 'Priya Ramanathan',
    arrival, addDays(arrival, 2), ctx.roomTypeId,
    opts.roomId === undefined ? ctx.roomId : opts.roomId, ctx.ratePlanId,
    opts.channelCode === undefined ? 'BDC' : opts.channelCode,
    opts.otaReference === undefined ? `BDC-${seq}` : opts.otaReference,
    nowIso(), nowIso(),
  );
  return resId;
}

async function main() {
  process.stdout.write(`\nGuest messaging checks\n${'─'.repeat(22)}\nStub on ${stub.base}\n`);
  migrate();
  const ctx = seed();
  ACTOR.propertyId = ctx.propertyId;
  const P = ctx.propertyId;

  section('1 · Which channels can carry a reply');
  // Asserted against the codes the catalogue actually issues, not against the
  // implementation's own constants. The previous version of this section tested
  // `'AIRBNB'` and `'HW'` — neither of which the UI can create — so it passed
  // while every real Airbnb conversation was unreplyable and the screen told the
  // operator Airbnb "does not carry guest messages". A test that quotes the
  // implementation back to itself proves nothing.
  const code = (name: string): string => {
    const entry = CATALOGUE.find((c) => c.name.toLowerCase().startsWith(name.toLowerCase()));
    if (!entry) throw new Error(`No catalogue entry for ${name}`);
    return entry.code;
  };

  check('Booking.com carries messages',
    msg.channelCarriesMessages(code('Booking.com')), code('Booking.com'));
  check('Airbnb carries messages',
    msg.channelCarriesMessages(code('Airbnb')), code('Airbnb'));
  check('Hostelworld does not',
    msg.channelCarriesMessages(code('Hostelworld')) === false, code('Hostelworld'));
  check('a direct booking has no channel at all', msg.channelCarriesMessages(null) === false);

  // The drift guard. Without this, a rename on either side goes unnoticed again.
  check('every messaging OTA is reachable by the code the catalogue issues',
    ['Booking.com', 'Airbnb'].every((n) => msg.channelCarriesMessages(code(n))),
    ['Booking.com', 'Airbnb'].map((n) => `${n}=${code(n)}`));

  const capable = msg.messagingChannels(P);
  check('the list says which is which',
    capable.find((c) => c.code === code('Booking.com'))?.carriesMessages === true
    && capable.find((c) => c.code === code('Hostelworld'))?.carriesMessages === false, capable);

  section('2 · Pulling a conversation in');
  const res = booking(ctx, { guest: 'Priya Ramanathan' });
  inboundMessages = [
    { id: 'm-1', message: 'Hello, could we check in early?', time: '2026-06-04T09:00:00Z', source: 'guest' },
    { id: 'm-2', message: 'We can hold your bags from 10am.', time: '2026-06-04T09:20:00Z', source: 'host' },
  ];
  const first = await msg.pollChannelMessages(P, ACTOR, TODAY);
  check('the poll imported both messages', first.imported === 2, first);
  const t1 = msg.thread(P, res);
  check('they are on the thread', t1.length === 2, t1.length);
  check('the guest message is inbound', t1[0].direction === 'in', t1[0]);
  check('the property message is outbound', t1[1].direction === 'out', t1[1]);
  check('the channel is recorded', t1[0].channelCode === 'BDC');
  check('the channel id is kept for dedup', t1[0].externalId === 'm-1');
  check('the guest is named as the author', t1[0].author === 'Priya Ramanathan');

  const second = await msg.pollChannelMessages(P, ACTOR, TODAY);
  check('polling again imports nothing new', second.imported === 0, second);
  check('and says it skipped them', second.skipped === 2, second);
  check('the thread is unchanged', msg.thread(P, res).length === 2);

  inboundMessages = [
    ...inboundMessages,
    { id: 'm-3', message: 'Perfect, thank you!', time: '2026-06-04T09:25:00Z', source: 'guest' },
  ];
  const third = await msg.pollChannelMessages(P, ACTOR, TODAY);
  check('a new message is picked up', third.imported === 1, third);
  check('without duplicating the old ones', msg.thread(P, res).length === 3);

  section('3 · Unread state');
  check('inbound messages start unread', msg.unreadCount(P) === 2, msg.unreadCount(P));
  const read = msg.markThreadRead(P, res);
  check('reading the thread clears them', read.read === 2, read);
  check('the count drops to zero', msg.unreadCount(P) === 0);
  check('reading again changes nothing', msg.markThreadRead(P, res).read === 0);

  section('4 · Replying through the channel');
  mode = 'ok';
  const reply = await msg.sendGuestMessage(P, ACTOR, {
    reservationId: res, body: 'Your room will be ready at 1pm.',
  });
  check('the reply is accepted by the channel', reply.status === 'accepted', reply);
  check('it is not claimed as delivered',
    (reply.status as string) !== 'delivered', reply.status);
  check('it went out through the channel', reply.localOnly === false);
  const outbound = sent[sent.length - 1];
  check('the channel got the booking reference',
    outbound?.[0]?.bookingId === 'BDC-1', outbound);
  check('and the message body', outbound?.[0]?.message === 'Your room will be ready at 1pm.');
  const t2 = msg.thread(P, res);
  check('the reply is on the thread', t2.length === 4);
  check('with an accepted timestamp', !!t2[3].acceptedAt, t2[3]);

  section('5 · A reply that does not get through');
  mode = 'item-error';
  const refused = await msg.sendGuestMessage(P, ACTOR, {
    reservationId: res, body: 'One more thing…',
  });
  check('a rejection inside a 200 is a failure', refused.status === 'failed', refused);
  check('the channel\'s reason is kept',
    /messaging is closed/i.test(refused.error ?? ''), refused.error);
  const t3 = msg.thread(P, res);
  // Losing a typed reply is worse than failing to send it.
  check('the typed reply is still on the thread', t3.length === 5, t3.length);
  check('and is labelled failed', t3[4].status === 'failed', t3[4]);
  check('with the error attached', !!t3[4].error);

  mode = 'http-error';
  const down = await msg.sendGuestMessage(P, ACTOR, { reservationId: res, body: 'Are you there?' });
  check('a transport error is a failure too', down.status === 'failed', down);
  check('with the status code kept', /502/.test(down.error ?? ''), down.error);

  mode = 'ok';
  const retried = await msg.deliverMessage(P, ACTOR, down.id);
  check('a failed message can be retried', retried.status === 'accepted', retried);
  const afterRetry = msg.thread(P, res).find((m) => m.id === down.id);
  check('the error is cleared on success', afterRetry?.error === null, afterRetry);
  check('and the attempts are counted', (afterRetry?.attempts ?? 0) === 2, afterRetry?.attempts);

  let alreadyGone = false;
  try { await msg.deliverMessage(P, ACTOR, down.id); } catch { alreadyGone = true; }
  check('an accepted message is not sent twice', alreadyGone);

  section('6 · Channels that cannot carry a reply');
  const hostelworld = booking(ctx, { channelCode: 'HW', otaReference: 'HWD-9', guest: 'Tom Baker' });
  const noRelay = await msg.sendGuestMessage(P, ACTOR, {
    reservationId: hostelworld, body: 'Welcome!',
  });
  check('the reply is not sent', noRelay.localOnly === true, noRelay);
  check('it is kept as a draft, not lost', noRelay.status === 'draft');
  check('and says the channel cannot carry it',
    /does not carry guest messages/i.test(noRelay.error ?? ''), noRelay.error);
  check('the draft is on the thread', msg.thread(P, hostelworld).length === 1);
  check('nothing was sent to the channel',
    !sent.some((s) => s?.[0]?.bookingId === 'HWD-9'), sent.length);

  const direct = booking(ctx, { channelCode: null, otaReference: null, guest: 'Walk In' });
  const noChannel = await msg.sendGuestMessage(P, ACTOR, {
    reservationId: direct, body: 'Thanks for staying.',
  });
  check('a direct booking keeps the message locally', noChannel.localOnly === true);
  check('and explains there is nowhere to send it',
    /nowhere to send it/i.test(noChannel.error ?? ''), noChannel.error);

  let empty = false;
  try { await msg.sendGuestMessage(P, ACTOR, { reservationId: res, body: '   ' }); }
  catch { empty = true; }
  check('an empty message is refused', empty);

  section('7 · The inbox');
  const box = msg.inbox(P, TODAY);
  check('one row per conversation', box.length === 3, box.map((b) => b.confirmation));
  check('the newest conversation is first',
    box[0].lastAt >= box[box.length - 1].lastAt, box.map((b) => b.lastAt));
  const priya = box.find((b) => b.guest === 'Priya Ramanathan')!;
  check('it carries the booking context',
    priya.room === '402' && priya.roomType === 'Deluxe King', priya);
  check('and the last thing said', !!priya.lastBody, priya.lastBody);
  check('it says whether a reply can be sent', priya.canReplyViaChannel === true);
  const tom = box.find((b) => b.guest === 'Tom Baker')!;
  check('…and when it cannot', tom.canReplyViaChannel === false, tom);
  check('failed messages are counted on the thread', priya.failed >= 1, priya.failed);

  inboundMessages = [{ id: 'm-9', message: 'Running late', time: nowIso(), source: 'guest' }];
  await msg.pollChannelMessages(P, ACTOR, TODAY);
  const unreadOnly = msg.inbox(P, TODAY, { unread: true });
  check('the unread filter narrows the list', unreadOnly.length === 1, unreadOnly.length);
  check('to the one with an unanswered guest message',
    unreadOnly[0]?.unread === 1, unreadOnly[0]);

  const searched = msg.inbox(P, TODAY, { search: 'Tom' });
  check('search finds a conversation by guest', searched.length === 1, searched.length);
  const byChannel = msg.inbox(P, TODAY, { channelCode: 'HW' });
  check('and it can be filtered by channel', byChannel.length === 1, byChannel.length);

  section('8 · Templates');
  const tpl = msg.upsertTemplate(P, ACTOR, {
    code: 'welcome', name: 'Welcome',
    body: 'Hello {{firstName}}, your {{roomType}} (room {{room}}) is ready from {{checkInTime}} on {{arrival}}.',
  });
  check('a template can be saved', !!tpl.id);
  check('it appears in the list', msg.listTemplates(P).length === 1);

  const rendered = msg.renderTemplate(P, msg.listTemplates(P)[0].body, res);
  check('the guest\'s first name is filled in', /Hello Priya,/.test(rendered), rendered);
  check('the room type is filled in', /Deluxe King/.test(rendered), rendered);
  check('the room number is filled in', /room 402/.test(rendered), rendered);
  check('the check-in time is filled in', /14:00/.test(rendered), rendered);
  check('the arrival date is filled in', new RegExp(TODAY).test(rendered), rendered);
  check('nothing is left unmerged', !/\{\{/.test(rendered), rendered);

  // An unknown field left visible is fixable; blanked, it ships broken.
  const unknown = msg.renderTemplate(P, 'See you {{arrivalDate}}', res);
  check('an unknown merge field is left visible', /\{\{arrivalDate\}\}/.test(unknown), unknown);

  const noBooking = msg.renderTemplate(P, 'Hello {{firstName}}', undefined);
  check('rendering without a booking changes nothing', noBooking === 'Hello {{firstName}}');

  msg.upsertTemplate(P, ACTOR, { id: tpl.id, code: 'welcome', name: 'Welcome back', body: 'Hi' });
  check('a template can be edited', msg.listTemplates(P)[0].name === 'Welcome back');
  msg.deleteTemplate(P, ACTOR, tpl.id);
  check('and deleted', msg.listTemplates(P).length === 0);

  let noBody = false;
  try { msg.upsertTemplate(P, ACTOR, { code: 'x', name: 'X', body: '' }); } catch { noBody = true; }
  check('an empty template is refused', noBody);

  section('9 · The trail');
  const syncRows = all<any>(`SELECT * FROM channel_sync_log WHERE property_id = ?`, P);
  check('polls are logged', syncRows.some((r) => r.direction === 'pull'), syncRows.length);
  check('sends are logged', syncRows.some((r) => r.direction === 'push'), syncRows.length);
  check('a failed send is logged as failed',
    syncRows.some((r) => r.direction === 'push' && r.status === 'failed'));
  const auditRows = all<any>(`SELECT * FROM audit_log WHERE action = 'message.send'`);
  check('every send is audited', auditRows.length >= 4, auditRows.length);

  process.stdout.write(`\n${checks - failures}/${checks} messaging checks passed\n`);
  if (failures) { process.exitCode = 1; return; }
  process.stdout.write(
    'Conversations arrive, replies go out, and a reply that did not get through says so.\n'
    + '🔌 Which channels relay messages still needs confirming against a live Beds24 account.\n');
}

try {
  await main();
} catch (e) {
  process.stderr.write(`\nAborted: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
} finally {
  stub.server.close();
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}
