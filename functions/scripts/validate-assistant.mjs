#!/usr/bin/env node
/**
 * validate-assistant.mjs — pin the website assistant's brain without Firebase.
 *
 *   node scripts/validate-assistant.mjs            # pure checks: tool exposure, reply parsing,
 *                                                  #   cards, history trimming, tool-result bounding
 *   GEMINI_API_KEY=… node scripts/validate-assistant.mjs --live
 *                                                  # + a real Gemini loop with a FAKE platform:
 *                                                  #   search → cards → enquiry, guest and member
 *
 * The live run is the one to eyeball after touching the system instruction: it prints every tool
 * call the model made and the final reply, so a prompt regression ("it started interrogating
 * instead of searching") is visible before it reaches a customer's site.
 */
import assert from 'node:assert/strict';
import {
  TOOL_DEFS, toolsFor, buildSystemInstruction, parseReply, listingsFromToolResult,
  rememberListings, cardsFor, boundToolResult, toolResultsContent, trimHistory, modelStep,
  MAX_HISTORY_CONTENTS, MAX_TOOL_RESULT_CHARS,
} from '../utils/assistant.js';

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('assistant: pure checks');

check('guests never see member-only tools', () => {
  const names = toolsFor({ capabilities: [], signedIn: false }).map((t) => t.name);
  assert.ok(names.includes('search_properties'));
  assert.ok(names.includes('create_enquiry'));
  assert.ok(!names.includes('list_my_properties'));
  assert.ok(!names.includes('list_my_leads'));
  assert.ok(!names.includes('get_my_plan'));
});

check('members see everything the platform declares, and nothing it does not', () => {
  const names = toolsFor({ capabilities: ['search_properties', 'list_my_leads', 'not_a_tool'], signedIn: true }).map((t) => t.name);
  assert.deepEqual(names.sort(), ['list_my_leads', 'search_properties']);
});

check('every tool declaration is a valid function declaration', () => {
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    assert.match(name, /^[a-z_]+$/);
    assert.ok(def.description.length > 40, `${name} needs a real description`);
    assert.equal(def.parameters.type, 'object');
  }
});

check('system instruction adapts to guest vs member and to the page', () => {
  const guest = buildSystemInstruction({ site: { name: 'MaadiVeedu', cities: ['Chennai'] }, user: {}, page: {}, locale: 'en' });
  assert.match(guest, /NOT signed in/);
  assert.match(guest, /Chennai/);
  const member = buildSystemInstruction({ site: {}, user: { id: 'u1', name: 'Kumar', phone: '+919876543210' }, page: { propertyId: 'PROP-1' }, locale: 'ta' });
  assert.match(member, /SIGNED IN as "Kumar"/);
  assert.match(member, /phone on file/);
  assert.match(member, /listing id PROP-1/);
  assert.match(member, /TAMIL/);
});

check('parseReply strips markers and returns ids + chips', () => {
  const r = parseReply('Here are two options in Velachery.\n[[show:PROP-A1, PROP-B2]]\n[[suggest:Enquire about the first|See more|Change budget]]');
  assert.equal(r.text, 'Here are two options in Velachery.');
  assert.deepEqual(r.showIds, ['PROP-A1', 'PROP-B2']);
  assert.deepEqual(r.suggestions, ['Enquire about the first', 'See more', 'Change budget']);
});

check('parseReply caps ids at 4 and chips at 3, flattens stray markdown', () => {
  const r = parseReply('**Bold** here [[show:a,b,c,d,e,f]] [[suggest:1|2|3|4|5]]');
  assert.equal(r.text, 'Bold here');
  assert.equal(r.showIds.length, 4);
  assert.equal(r.suggestions.length, 3);
});

check('cards come only from cached tool results — an invented id renders nothing', () => {
  const fresh = listingsFromToolResult('search_properties', {
    items: [
      { id: 'PROP-A1', title: '2 BHK in Velachery', price: 18000, bhk: 2, locality: 'Velachery', city: 'Chennai', url: '/property/x--PROP-A1', image: 'https://i/1.jpg', listingType: 'rent' },
      { id: 'PROP-B2', title: '3 BHK Adyar', price: 4500000 },
    ],
  });
  assert.equal(fresh.length, 2);
  assert.equal(fresh[0].priceLabel, '₹18,000');
  assert.equal(fresh[1].priceLabel, '₹45 L');
  const remembered = rememberListings([], fresh);
  const cards = cardsFor(['PROP-B2', 'PROP-INVENTED'], remembered);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'PROP-B2');
  assert.ok(!('fromTool' in cards[0]));
});

check('get_property results are remembered too', () => {
  const one = listingsFromToolResult('get_property', { property: { id: 'PROP-Z', title: 'Villa', price: 12000000 } });
  assert.equal(one.length, 1);
  assert.equal(one[0].priceLabel, '₹1.2 Cr');
});

check('tool results are bounded — big arrays shrink, and the model is told', () => {
  const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: `P${i}`, title: 'x'.repeat(120) })) };
  const b = boundToolResult(big);
  assert.ok(JSON.stringify(b).length <= MAX_TOOL_RESULT_CHARS);
  assert.equal(b.truncated, true);
  assert.ok(b.items.length > 0 && b.items.length < 200);
  assert.deepEqual(boundToolResult({ ok: true }), { ok: true });
});

check('tool results map back to the pending calls by id, missing ones become errors', () => {
  const pending = [{ id: 'c1', name: 'search_properties' }, { id: 'c2', name: 'get_property' }];
  const c = toolResultsContent(pending, [{ id: 'c2', name: 'get_property', result: { ok: true } }]);
  assert.equal(c.role, 'user');
  assert.equal(c.parts[0].functionResponse.name, 'search_properties');
  assert.match(c.parts[0].functionResponse.response.error, /no result/);
  assert.deepEqual(c.parts[1].functionResponse.response, { ok: true });
});

check('history trimming starts on a plain user turn, never mid tool exchange', () => {
  const contents = [];
  for (let i = 0; i < 30; i++) {
    contents.push({ role: 'user', parts: [{ text: `q${i}` }] });
    contents.push({ role: 'model', parts: [{ functionCall: { name: 'search_properties', args: {} } }] });
    contents.push({ role: 'user', parts: [{ functionResponse: { name: 'search_properties', response: {} } }] });
    contents.push({ role: 'model', parts: [{ text: `a${i}` }] });
  }
  const t = trimHistory(contents);
  assert.ok(t.length <= MAX_HISTORY_CONTENTS);
  assert.equal(t[0].role, 'user');
  assert.ok(typeof t[0].parts[0].text === 'string');
});

console.log(`  ${passed} passed`);

// ── Live: a fake platform answering a real model ─────────────────────────────────────────────────
if (process.argv.includes('--live')) {
  if (!process.env.GEMINI_API_KEY && !process.env.VERTEX_PROJECT) {
    console.error('live: set GEMINI_API_KEY (or VERTEX_PROJECT)');
    process.exit(1);
  }
  const FAKE = {
    search_properties: (args) => ({
      ok: true,
      total: 2,
      items: [
        { id: 'PROP-VEL1', title: '2 BHK flat near Phoenix Mall', price: 19000, priceLabel: '₹19,000/month', bhk: 2, listingType: 'rent', propertyType: 'apartment', locality: args.locality || 'Velachery', city: 'Chennai', url: 'https://maadiveedu.com/property/2bhk-flat-rent-velachery-chennai--PROP-VEL1', image: 'https://picsum.photos/300' },
        { id: 'PROP-VEL2', title: '2 BHK independent house, Taramani Link Rd', price: 16500, priceLabel: '₹16,500/month', bhk: 2, listingType: 'rent', propertyType: 'house', locality: 'Velachery', city: 'Chennai', url: 'https://maadiveedu.com/property/x--PROP-VEL2', image: '' },
      ],
    }),
    get_property: (args) => ({ ok: true, property: { id: args.propertyId, title: '2 BHK flat near Phoenix Mall', price: 19000, bhk: 2, locality: 'Velachery', city: 'Chennai', description: 'Semi-furnished, 2nd floor, lift, covered parking, 950 sqft. Deposit 5 months.', url: 'https://maadiveedu.com/property/x--PROP-VEL1' } }),
    create_enquiry: (args) => ({ ok: true, enquiryId: 'enq_1', propertyId: args.propertyId }),
    request_property: () => ({ ok: true, requirementId: 'req_1' }),
    draft_listing: () => ({ ok: true, url: 'https://maadiveedu.com/complete/abc123', expiresInDays: 7 }),
    list_my_properties: () => ({ ok: true, items: [{ id: 'PROP-MINE', title: '3 BHK Anna Nagar', status: 'live', views: 212, enquiries: 4, url: 'https://maadiveedu.com/property/x--PROP-MINE', price: 8500000 }] }),
    list_my_leads: () => ({ ok: true, items: [{ propertyId: 'PROP-MINE', name: 'Ravi', phone: '98xxxxxx10', when: '2 days ago', message: 'Is it negotiable?' }] }),
    get_my_plan: () => ({ ok: true, plan: { name: 'Free', activeListings: 1, maxActiveListings: 2, expires: null }, upgrades: [{ name: 'Basic', price: 999, cycle: 'monthly', includes: '5 listings, 10 photos each' }] }),
    list_plans: () => ({ ok: true, plans: [{ name: 'Free', price: 0 }, { name: 'Basic', price: 999, cycle: 'monthly' }] }),
  };

  async function converse(label, { user, locale = 'en', turns }) {
    console.log(`\nlive: ${label}`);
    const signedIn = !!user?.id;
    const tools = toolsFor({ capabilities: Object.keys(FAKE), signedIn });
    const systemInstruction = buildSystemInstruction({ site: { name: 'MaadiVeedu', cities: ['Chennai', 'Coimbatore', 'Madurai'] }, user: user || {}, page: {}, locale });
    let contents = [];
    let remembered = [];
    for (const message of turns) {
      console.log(`  > ${message}`);
      contents.push({ role: 'user', parts: [{ text: message }] });
      for (let hop = 0; hop < 5; hop++) {
        const step = await modelStep({ contents, systemInstruction, tools: hop >= 4 ? [] : tools });
        assert.ok(step, 'model returned null');
        contents.push(step.content);
        if (step.kind === 'tool_calls') {
          console.log(`    tools: ${step.calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}`);
          const results = step.calls.map((c) => ({ id: c.id, name: c.name, result: FAKE[c.name] ? FAKE[c.name](c.args) : { ok: false, error: 'unknown tool' } }));
          for (const r of results) remembered = rememberListings(remembered, listingsFromToolResult(r.name, r.result));
          contents.push(toolResultsContent(step.calls, results));
          continue;
        }
        const parsed = parseReply(step.text);
        const cards = cardsFor(parsed.showIds, remembered);
        console.log(`    < ${parsed.text.replace(/\n/g, ' ')}`);
        if (cards.length) console.log(`    cards: ${cards.map((c) => c.id).join(', ')}`);
        if (parsed.suggestions.length) console.log(`    chips: ${parsed.suggestions.join(' | ')}`);
        console.log(`    usage: ${JSON.stringify(step.usage)}`);
        break;
      }
    }
  }

  await converse('guest: search → enquire (must ask for phone first)', {
    user: null,
    turns: [
      '2 bhk for rent in velachery under 20k',
      'i want to enquire about the first one',
      'Priya, 9876543210',
    ],
  });
  await converse('member in Tamil: my leads', {
    user: { id: 'u1', name: 'Kumar', phone: '+919876543210', role: 'seller' },
    locale: 'ta',
    turns: ['என் லீட்ஸ் என்ன?'],
  });
  await converse('guest: sell a house → draft link', {
    user: null,
    turns: ['I want to sell my 3bhk house in Anna Nagar', '1.2 crore, 1800 sqft, my number is 9123456789'],
  });
  await converse('guest: nothing found → requirement', {
    user: null,
    turns: ['what is the capital of france'],
  });
}
