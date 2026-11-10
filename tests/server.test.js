const fs = require('fs');
const path = require('path');
const vm = require('vm');

// server.js uses FDK's required `exports = {...}` convention (its own static validator
// rejects `module.exports = {...}`), which reassigns the *local* `exports` parameter
// rather than mutating `module.exports` — so a plain `require()` here would just see
// the original empty object. FDK's own runtime reads that local variable directly;
// we replicate that by wrapping the file in the same Node module signature ourselves
// and returning the local `exports` binding instead of `module.exports`.
//
// Uses vm.compileFunction (not `new Function`) with `filename` set to the real path —
// `code` is always this repo's own server/server.js read from a fixed local path, never
// user input, so there's no injection surface here; the filename is what lets V8's
// coverage collector attribute executed lines back to the actual source file on disk
// instead of reporting 0% against an anonymous compiled script.
function loadServerModule() {
  const filePath = path.join(__dirname, '../server/server.js');
  const code = fs.readFileSync(filePath, 'utf8');
  const compiled = vm.compileFunction(
    `${code}\nreturn exports;`,
    ['exports', 'require', 'module', '__filename', '__dirname'],
    { filename: filePath }
  );
  const fakeModule = { exports: {} };
  return compiled(fakeModule.exports, require, fakeModule, filePath, path.dirname(filePath));
}

// Reloaded before every test. server.js keeps module-level caches (the shard cursor and
// the day index) that deliberately persist for the life of a warm serverless container —
// so a single shared instance would leak one test's cursor into the next, and a test
// asserting on a cold-start read would silently get a cached value instead.
let server = loadServerModule();

// server.js calls the bare global `$request.invokeTemplate(...)` (the FDK sandbox
// injects this at runtime) — for unit tests we stand it up as a real Node global and
// route by template name so each test controls exactly what each call returns.
function mockRequest({
  kbResponses = [{ articles: [] }],
  claudeContent,
  claudeUsage,
  claudeStopReason,
  claudeError,
  claudeStatus = 200,
  claudeResponses,
  openaiOutput,
  openaiUsage,
  openaiIncompleteReason,
  openaiRawResponse,
  openaiStatus = 200,
  copilotContent,
  copilotUsage,
  copilotFinishReason,
  copilotStatus = 200,
  addNoteError,
  ticketFieldsResponse = { ticket_fields: [] },
  ticketFieldsError,
} = {}) {
  let kbCallIndex = 0;
  let claudeCallIndex = 0;
  return vi.fn(async (template) => {
    if (template === 'freshserviceKbSearch') {
      const next = kbResponses[Math.min(kbCallIndex, kbResponses.length - 1)];
      kbCallIndex += 1;
      if (next instanceof Error) throw next;
      return { response: JSON.stringify(next) };
    }
    if (template === 'freshserviceTicketFields') {
      if (ticketFieldsError) throw ticketFieldsError;
      return { response: JSON.stringify(ticketFieldsResponse) };
    }
    if (template === 'anthropicMessages') {
      if (claudeResponses) {
        const r = claudeResponses[Math.min(claudeCallIndex, claudeResponses.length - 1)];
        claudeCallIndex += 1;
        return { status: r.status, response: JSON.stringify({ content: r.content, usage: r.usage, stop_reason: r.stop_reason }) };
      }
      if (claudeError) throw claudeError;
      return { status: claudeStatus, response: JSON.stringify({ content: claudeContent, usage: claudeUsage, stop_reason: claudeStopReason }) };
    }
    if (template === 'openaiResponses') {
      // openaiRawResponse returns a body verbatim — needed for error payloads (e.g. the
      // quota-exhausted 429) whose shape isn't the normal Responses envelope.
      if (openaiRawResponse !== undefined) {
        return { status: openaiStatus, response: openaiRawResponse };
      }
      return {
        status: openaiStatus,
        response: JSON.stringify({
          output: openaiOutput,
          usage: openaiUsage,
          incomplete_details: openaiIncompleteReason ? { reason: openaiIncompleteReason } : null,
        }),
      };
    }
    if (template === 'copilotChatCompletions') {
      return {
        status: copilotStatus,
        response: JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: copilotContent },
            finish_reason: copilotFinishReason || 'stop',
          }],
          usage: copilotUsage,
        }),
      };
    }
    if (template === 'freshserviceAddNote') {
      if (addNoteError) throw addNoteError;
      return { response: JSON.stringify({}) };
    }
    throw new Error(`mockRequest: unexpected template "${template}"`);
  });
}

// Builds the raw text Claude would return: a note body, an optional suggested-new-category
// block, and the trailing RELEVANT_KB_IDS line the parser looks for.
function claudeText({ body = 'Note body.', suggestedCategory = null, relevantIds = 'none' } = {}) {
  let text = body;
  if (suggestedCategory) {
    text += `\n\nSUGGESTED_NEW_CATEGORY_START\n${suggestedCategory}\nSUGGESTED_NEW_CATEGORY_END`;
  }
  text += `\nRELEVANT_KB_IDS: ${relevantIds}`;
  return [{ type: 'text', text }];
}

// Builds the `output` array an OpenAI Responses call returns: zero or more
// web_search_call items (each with an action type), then the assistant message item
// carrying the note text and any url_citation annotations.
function openaiOutput({ body = 'Note body.', relevantIds = 'none', annotations = [], searchActions = [] } = {}) {
  const items = searchActions.map((type) => ({
    type: 'web_search_call',
    status: 'completed',
    action: { type },
  }));
  items.push({
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: `${body}\nRELEVANT_KB_IDS: ${relevantIds}`,
      annotations,
    }],
  });
  return items;
}

// A neutral incident that matches no recurring-deflection rule, so the AI-path tests
// below exercise triage rather than deflection. (Deflection matchers are covered in
// their own describe block.)
const baseTicket = { id: 71805, subject: 'Cannot connect to VPN from home', description_text: 'The Cisco AnyConnect client fails to establish a session.', group_id: 1 };
const baseIparams = { freshservice_domain: 'example.freshservice.com', anthropic_api_key: 'sk-ant-test', claude_model: 'claude-haiku-4-5-20251001', output_budget: 512 };

describe('onTicketCreateHandler', () => {
  beforeEach(() => {
    // Fresh module = cold container, so no shard cursor or day index carries over.
    server = loadServerModule();
    // Stub FDK Data Storage globals so $db writes in the handler don't throw.
    global.$db = {
      get: vi.fn().mockRejectedValue({ message: 'not found' }),
      set: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
  });

  test('is exported as a function', () => {
    expect(typeof server.onTicketCreateHandler).toBe('function');
  });

  test('PoC group gate: skips tickets outside poc_group_id without calling $request at all', async () => {
    global.$request = { invokeTemplate: mockRequest() };
    await server.onTicketCreateHandler({
      data: { ticket: { ...baseTicket, group_id: 1 } },
      iparams: { ...baseIparams, poc_group_id: 999 },
    });
    expect(global.$request.invokeTemplate).not.toHaveBeenCalled();
  });

  test('PoC group gate: proceeds when ticket is inside poc_group_id', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({
      data: { ticket: { ...baseTicket, group_id: 999 } },
      iparams: { ...baseIparams, poc_group_id: 999 },
    });
    expect(global.$request.invokeTemplate).toHaveBeenCalled();
  });

  test('PoC workspace gate: skips tickets outside poc_workspace_id without calling $request at all', async () => {
    global.$request = { invokeTemplate: mockRequest() };
    await server.onTicketCreateHandler({
      data: { ticket: { ...baseTicket, workspace_id: 1 } },
      iparams: { ...baseIparams, poc_workspace_id: 2 },
    });
    expect(global.$request.invokeTemplate).not.toHaveBeenCalled();
  });

  test('PoC workspace gate: proceeds when ticket is inside poc_workspace_id', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({
      data: { ticket: { ...baseTicket, workspace_id: 2 } },
      iparams: { ...baseIparams, poc_workspace_id: 2 },
    });
    expect(global.$request.invokeTemplate).toHaveBeenCalled();
  });

  test('PoC gates combined: both group and workspace must match when both are set', async () => {
    global.$request = { invokeTemplate: mockRequest() };
    await server.onTicketCreateHandler({
      data: { ticket: { ...baseTicket, group_id: 999, workspace_id: 1 } },
      iparams: { ...baseIparams, poc_group_id: 999, poc_workspace_id: 2 },
    });
    expect(global.$request.invokeTemplate).not.toHaveBeenCalled();
  });

  test('KB search: subject query finds articles directly, no fallback query needed', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [{ id: 1, title: 'Match', description: 'x' }] }],
      claudeContent: claudeText({ relevantIds: '1' }),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const kbSearchCalls = global.$request.invokeTemplate.mock.calls.filter(([t]) => t === 'freshserviceKbSearch');
    expect(kbSearchCalls).toHaveLength(1);
  });

  test('KB search: falls back to a description-based query when the subject query is empty', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }, { articles: [{ id: 2, title: 'Fallback match', description: 'x' }] }],
      claudeContent: claudeText({ relevantIds: '2' }),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const kbSearchCalls = global.$request.invokeTemplate.mock.calls.filter(([t]) => t === 'freshserviceKbSearch');
    expect(kbSearchCalls).toHaveLength(2);
  });

  test('KB search: a known Application name mentioned in the ticket is tried first, ahead of the subject', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [{ id: 7, title: 'KwikTag help', description: 'x' }] }],
      claudeContent: claudeText({ relevantIds: '7' }),
      ticketFieldsResponse: {
        ticket_fields: [
          { name: 'category', choices: [
            { value: 'Application', nested_options: [{ value: 'KwikTag' }, { value: 'Adobe Creative Cloud' }] },
          ] },
        ],
      },
    }) };
    const ticket = { id: 71805, subject: 'Error in KT', description_text: 'message in KwikTag keeps popping up' };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const kbSearchCalls = global.$request.invokeTemplate.mock.calls.filter(([t]) => t === 'freshserviceKbSearch');
    expect(kbSearchCalls).toHaveLength(1);
    expect(decodeURIComponent(kbSearchCalls[0][1].context.search_term)).toBe('KwikTag');
  });

  test('KB search: no known Application name mentioned falls back to stopword-stripped subject text', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [{ id: 8, title: 'Match', description: 'x' }] }],
      claudeContent: claudeText({ relevantIds: '8' }),
      ticketFieldsResponse: {
        ticket_fields: [
          { name: 'category', choices: [{ value: 'Application', nested_options: [{ value: 'KwikTag' }] }] },
        ],
      },
    }) };
    const ticket = { id: 71805, description_text: 'Error in the System, unrelated body text' };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const kbSearchCalls = global.$request.invokeTemplate.mock.calls.filter(([t]) => t === 'freshserviceKbSearch');
    const term = decodeURIComponent(kbSearchCalls[0][1].context.search_term);
    expect(term).not.toContain('KwikTag');
    expect(term.split(' ')).not.toContain('in');
    expect(term.split(' ')).not.toContain('the');
    expect(term).toContain('System');
  });

  test('KB search: a failed lookup is swallowed and treated as no articles found', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [new Error('search down')],
      claudeContent: claudeText(),
    }) };
    await expect(
      server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams })
    ).resolves.not.toThrow();
    const addNoteCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(addNoteCall[1].body).toContain('none found');
  });

  test('RELEVANT_KB_IDS: none — footer shows no match even though search found an article', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [{ id: 3, title: 'Not actually relevant', description: 'x' }] }],
      claudeContent: claudeText({ relevantIds: 'none' }),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    const posted = JSON.parse(addNoteOpts.body).body;
    expect(posted).toContain('none found');
  });

  test('KB search: only the top article is kept even if the backend returns more', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [
        { id: 1, title: 'First', description: 'x' },
        { id: 2, title: 'Second', description: 'x' },
        { id: 3, title: 'Third', description: 'x' },
      ] }],
      claudeContent: claudeText({ relevantIds: '1' }),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toContain('First');
    expect(sentBody.messages[0].content).not.toContain('Second');
    expect(sentBody.messages[0].content).not.toContain('Third');
  });

  test('RELEVANT_KB_IDS omitted — falls back to showing every article the search found', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [{ id: 4, title: 'Shown by default', description: 'x' }] }],
      claudeContent: [{ type: 'text', text: 'Note with no structured line at all.' }],
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    const posted = JSON.parse(addNoteOpts.body).body;
    expect(posted).toContain('Shown by default');
  });

  test('empty Claude response: no note is posted', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }, { articles: [] }],
      claudeContent: [],
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const addNoteCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(addNoteCall).toBeUndefined();
  });

  test('Claude call failure: caught, no throw, no note posted', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }, { articles: [] }],
      claudeError: new Error('anthropic down'),
    }) };
    await expect(
      server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams })
    ).resolves.not.toThrow();
    const addNoteCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(addNoteCall).toBeUndefined();
  });

  test('db write: $db.set failure is caught — triage note still posts normally', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    global.$db = {
      get: vi.fn().mockRejectedValue({ message: 'not found' }),
      set: vi.fn().mockRejectedValue({ message: 'storage error' }),
    };
    await expect(
      server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams })
    ).resolves.not.toThrow();
    const addNoteCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(addNoteCall).toBeDefined();
  });

  test('db write: appends atomically — never reads the shard first', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    global.$db = {
      get: vi.fn().mockImplementation((key) => {
        if (key.startsWith('triage_cur_')) return Promise.resolve({ shard: 2 });
        return Promise.reject({ message: 'not found' });
      }),
      set: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });

    const append = global.$db.update.mock.calls.find(([, type]) => type === 'append');
    expect(append).toBeDefined();
    expect(append[0]).toMatch(/^triage_d_.*_2$/);                 // the cursor's shard
    expect(append[2].entries[0].ticket_id).toBe(baseTicket.id);
    // The whole point: no read-modify-write, so two concurrent handlers cannot
    // overwrite each other. Nothing may read a shard bucket.
    const shardRead = global.$db.get.mock.calls.find(([k]) => /^triage_d_/.test(k));
    expect(shardRead).toBeUndefined();
  });

  test('db write: a full shard (40KB cap) advances and re-appends to the next shard', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    // An atomic append cannot report length, so a full shard announces itself by the
    // platform throwing the size exception. That throw is the advance signal.
    global.$db = {
      get: vi.fn().mockImplementation((key) => {
        if (key.startsWith('triage_cur_')) return Promise.resolve({ shard: 0 });
        return Promise.reject({ message: 'not found' });
      }),
      set: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockImplementation((key) => {
        if (/_0$/.test(key)) {
          return Promise.reject({ message: 'Item size exceeded the maximum limit of 40 KB' });
        }
        return Promise.resolve({});
      }),
    };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });

    const shard1Append = global.$db.update.mock.calls.find(([k, type]) => /_1$/.test(k) && type === 'append');
    expect(shard1Append).toBeDefined();
    expect(shard1Append[2].entries[0].ticket_id).toBe(baseTicket.id);
    // and the cursor moves forward so the next cold container starts in the right place
    const cursorWrite = global.$db.set.mock.calls.find(([k, v]) => k.startsWith('triage_cur_') && v.shard === 1);
    expect(cursorWrite).toBeDefined();
  });

  test('db write: a missing shard record is created with setIf not_exist, never blindly', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    // append requires the record to exist; the first entry of a shard must create it.
    // CAS matters because a concurrent handler may be creating the same shard.
    global.$db = {
      get: vi.fn().mockRejectedValue({ message: 'not found' }),
      set: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockRejectedValue({ message: 'record not found' }),
    };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });

    const create = global.$db.set.mock.calls.find(([k, v]) => /^triage_d_/.test(k) && v.entries);
    expect(create).toBeDefined();
    expect(create[2]).toEqual({ setIf: 'not_exist' });
    expect(create[1].entries[0].ticket_id).toBe(baseTicket.id);
  });

  test('db write: a rate-limited append drops the entry rather than corrupting the shard', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    // Data Storage allows ~50 req/min. Losing one entry is acceptable; writing over a
    // populated shard is not. Nothing may be written to a shard on this path.
    global.$db = {
      get: vi.fn().mockImplementation((key) => {
        if (key.startsWith('triage_cur_')) return Promise.resolve({ shard: 4 });
        return Promise.reject({ message: 'not found' });
      }),
      set: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockRejectedValue({
        message: 'You have exceeded the limit of 50 requests per minute',
      }),
    };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });

    // Note still posts — storage trouble must never cost the customer their triage note
    expect(global.$request.invokeTemplate.mock.calls.some(([t]) => t === 'freshserviceAddNote')).toBe(true);
    const shardWrite = global.$db.set.mock.calls.find(([k]) => /^triage_d_/.test(k));
    expect(shardWrite).toBeUndefined();
  });

  // 2026-08-27: the day index collapsed to a single date, hiding 1,657 intact entries and
  // presenting to the operator as total data loss. A read that RESOLVES with a non-array
  // was coerced to [], then written back as a one-element index. "I don't know what's in
  // there" must never be recorded as "there is nothing in there".
  function dbWithDaysValue(daysValue) {
    return {
      get: vi.fn().mockImplementation((key) => {
        if (key === 'triage_days') return Promise.resolve(daysValue);
        if (key.startsWith('triage_cur_')) return Promise.resolve({ shard: 0 });
        return Promise.reject({ message: 'not found' });
      }),
      set: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
  }
  function daysWrite() {
    return global.$db.set.mock.calls.find(([k]) => k === 'triage_days');
  }

  // THE root cause. FDK hands a stored top-level array back as {0:v,1:v,...}, so the
  // server's Array.isArray() check failed on every cold container and rewrote the index
  // as a single date. Deterministic, not a race — this is the test that matters most.
  test('day index: FDK\'s {0:v,1:v} array shape is understood, not mistaken for empty', async () => {
    global.$request = { invokeTemplate: mockRequest({ claudeContent: claudeText() }) };
    global.$db = dbWithDaysValue({ 0: '2026-08-24', 1: '2026-08-23', 2: '2026-08-22' });
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const write = daysWrite();
    expect(write, 'today should still be recorded').toBeDefined();
    // Every pre-existing date survives, today is prepended, nothing is lost.
    expect(write[1]).toEqual(expect.arrayContaining(['2026-08-24', '2026-08-23', '2026-08-22']));
    expect(write[1].length).toBe(4);
  });

  test('day index: a non-array read leaves triage_days ALONE rather than truncating it', async () => {
    global.$request = { invokeTemplate: mockRequest({ claudeContent: claudeText() }) };
    // A scalar cannot be an index and cannot be interpreted as one.
    global.$db = dbWithDaysValue('not-an-index');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const logged = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(daysWrite(), 'must not overwrite an index it could not read').toBeUndefined();
    expect(logged).toContain('leaving the index untouched');
  });

  test('day index: an object holding no dates is "unknown", not "empty"', async () => {
    global.$request = { invokeTemplate: mockRequest({ claudeContent: claudeText() }) };
    // e.g. an error payload spread into pseudo-entries — the client once scanned a range
    // starting at "APP" because a 429 body's values were treated as dates.
    global.$db = dbWithDaysValue({ 0: 'APP', 1: 429 });
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    expect(daysWrite()).toBeUndefined();
  });

  test('day index: an existing array is EXTENDED, never replaced', async () => {
    global.$request = { invokeTemplate: mockRequest({ claudeContent: claudeText() }) };
    global.$db = dbWithDaysValue(['2026-08-24', '2026-08-23']);
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const write = daysWrite();
    expect(write).toBeDefined();
    // Today prepended; every previously-known date survives.
    expect(write[1]).toContain('2026-08-24');
    expect(write[1]).toContain('2026-08-23');
    expect(write[1].length).toBe(3);
  });

  test('day index: a rate-limited read (resolved 429 payload) does not truncate it either', async () => {
    global.$request = { invokeTemplate: mockRequest({ claudeContent: claudeText() }) };
    global.$db = dbWithDaysValue({ status: 429, message: 'You have exceeded the limit of 50 requests per minute' });
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    expect(daysWrite()).toBeUndefined();
  });

  test('db write: a rate-limited append RESOLVING with a 429 payload is also treated as failure', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    // The platform resolves rather than rejects on rate limit. Treating that resolution
    // as success is how entries were silently lost while the code believed it wrote them.
    global.$db = {
      get: vi.fn().mockImplementation((key) => {
        if (key.startsWith('triage_cur_')) return Promise.resolve({ shard: 0 });
        return Promise.reject({ message: 'not found' });
      }),
      set: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({
        status: 429,
        message: 'You have exceeded the limit of 50 requests per minute',
      }),
    };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });

    expect(global.$request.invokeTemplate.mock.calls.some(([t]) => t === 'freshserviceAddNote')).toBe(true);
    const shardWrite = global.$db.set.mock.calls.find(([k]) => /^triage_d_/.test(k));
    expect(shardWrite).toBeUndefined();
  });

  test('ticket with no description_text: falls back to stripping HTML out of description', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }, { articles: [] }],
      claudeContent: claudeText(),
    }) };
    const ticket = { id: 71805, subject: '', description: '<h1>Server Quarterly Maintenance</h1><div>details</div>', group_id: 1 };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toMatch(/Server Quarterly Maintenance\s+details/);
    expect(sentBody.messages[0].content).not.toContain('<h1>');
  });

  test('ticket with neither subject nor description: uses the "(no description)" placeholder', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    const ticket = { id: 71805, subject: '', group_id: 1 };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toContain('(no description)');
  });

  test('missing iparams / payload.data: does not throw, treats them as empty', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await expect(server.onTicketCreateHandler({})).resolves.not.toThrow();
  });

  test('missing claude_model / output_budget: falls back to defaults', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }, { articles: [] }],
      claudeContent: claudeText(),
    }) };
    const iparams = { freshservice_domain: 'example.freshservice.com', anthropic_api_key: 'sk-ant-test' };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.model).toBe('claude-sonnet-5');
    expect(sentBody.max_tokens).toBe(512);
  });

  test('adaptive thinking is disabled on every Claude call (protects the output budget on Sonnet 5)', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.thinking).toEqual({ type: 'disabled' });
  });

  test('KB search response missing the articles key entirely: treated as no articles', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{}, {}],
      claudeContent: claudeText(),
    }) };
    await expect(
      server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams })
    ).resolves.not.toThrow();
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(JSON.parse(addNoteOpts.body).body).toContain('none found');
  });

  test('Claude response missing the content key entirely: treated as empty, no note posted', async () => {
    global.$request = { invokeTemplate: vi.fn(async (template) => {
      if (template === 'freshserviceKbSearch') return { response: JSON.stringify({ articles: [] }) };
      if (template === 'anthropicMessages') return { status: 200, response: JSON.stringify({}) };
      throw new Error(`unexpected ${template}`);
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const addNoteCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(addNoteCall).toBeUndefined();
  });

  test('KB article missing the description field: snippet falls back to empty rather than throwing', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [{ id: 6, title: 'No description field' }] }],
      claudeContent: claudeText({ relevantIds: '6' }),
    }) };
    await expect(
      server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams })
    ).resolves.not.toThrow();
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(JSON.parse(addNoteOpts.body).body).toContain('No description field');
  });

  test('category taxonomy: real categories/sub-categories are fetched and passed to Claude', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      ticketFieldsResponse: {
        ticket_fields: [
          { name: 'category', choices: [
            { value: 'Account', nested_options: [{ value: 'Locked Out' }, { value: 'Password Reset' }] },
            { value: 'Hardware', nested_options: [] },
          ] },
        ],
      },
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toContain('Account: Locked Out, Password Reset');
    expect(sentBody.messages[0].content).toContain('Hardware');
  });

  test('category taxonomy: response missing the ticket_fields key entirely is treated as no categories', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      ticketFieldsResponse: {},
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toContain('No category list available');
  });

  test('category taxonomy: a choice missing nested_options entirely falls back to no sub-categories', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      ticketFieldsResponse: {
        ticket_fields: [
          { name: 'category', choices: [{ value: 'Bug' }] },
        ],
      },
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toContain('Bug');
  });

  test('category taxonomy: a failed fetch is swallowed and Claude is told none is available', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      ticketFieldsError: new Error('ticket_form_fields down'),
    }) };
    await expect(
      server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams })
    ).resolves.not.toThrow();
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toContain('No category list available');
  });

  test('uncategorized ticket (category "To Be Defined"): the note flags no match and renders the suggested new category', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText({
        body: 'Category: no good match found',
        suggestedCategory: 'Category: Streaming\nSub-Category: Encoder Dropout\nReason: no existing category covers live-stream encoder failures.',
      }),
    }) };
    const ticket = { ...baseTicket, category: 'To Be Defined', sub_category: 'Suggested Category in Notes' };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });

    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.system).toContain('has no category set');

    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    const posted = JSON.parse(addNoteOpts.body).body;
    expect(posted).toContain('No matching category found');
    expect(posted).toContain('Streaming');
    expect(posted).toContain('Encoder Dropout');
  });

  test('uncategorized ticket where Claude finds a real match: no suggested-new-category callout is added', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText({ body: 'Category: Network / Sub-Category: VPN' }),
    }) };
    const ticket = { ...baseTicket, category: 'To Be Defined' };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    const posted = JSON.parse(addNoteOpts.body).body;
    expect(posted).not.toContain('No matching category found');
  });

  test('normally categorized ticket: prompt does not mention the uncategorized fallback at all', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    const ticket = { ...baseTicket, category: 'Network', sub_category: 'VPN' };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.system).not.toContain('has no category set');
  });

  test('cost reduction: categorized ticket skips grounding entirely - no taxonomy sent, portal category rendered deterministically', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText({ body: 'One-line summary here.' }),
    }) };
    const ticket = { ...baseTicket, category: 'Network', sub_category: 'VPN' };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });

    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).not.toContain('Valid Category / Sub-Category list');
    expect(sentBody.system).not.toContain('has no category set');

    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    const posted = JSON.parse(addNoteOpts.body).body;
    expect(posted).toContain('Category: Network / Sub-Category: VPN');
    expect(posted).not.toContain('confirm the actual issue matches before applying');
  });

  test('cost reduction: categorized ticket without a sub-category omits the "/ Sub-Category" suffix', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    const ticket = { ...baseTicket, category: 'Bug', sub_category: null };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    const posted = JSON.parse(addNoteOpts.body).body;
    expect(posted).toContain('Category: Bug<br>');
    expect(posted).not.toContain('Sub-Category');
  });

  test('cost reduction: very long ticket descriptions are truncated before being sent to Claude', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    const longText = 'A'.repeat(2000);
    const ticket = { ...baseTicket, description_text: longText };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toContain('[truncated]');
    expect(sentBody.messages[0].content).not.toContain('A'.repeat(2000));
  });

  test('cost reduction: short ticket descriptions are sent in full, untruncated', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).not.toContain('[truncated]');
  });

  test('cost reduction: KB article snippet sent to Claude is capped at 200 characters', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [{ id: 1, title: 'Match', description: 'B'.repeat(500) }] }],
      claudeContent: claudeText({ relevantIds: '1' }),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    // Use the longest run, not the first — "Relevant KB articles" itself contains a
    // stray capital B (in "KB") that a naive /B+/ match would find first.
    const runs = sentBody.messages[0].content.match(/B+/g) || [];
    const longestRun = Math.max(...runs.map((r) => r.length));
    expect(longestRun).toBe(200);
  });

  test('ticket with category: null (not the literal "To Be Defined" string) is still treated as uncategorized', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    const ticket = { ...baseTicket, category: null, sub_category: null };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.system).toContain('has no category set');
  });

  test('cost reduction: system prompt omits the no-KB-match instructions when a KB match was already found', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [{ id: 1, title: 'Match', description: 'x' }] }],
      claudeContent: claudeText({ relevantIds: '1' }),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.system).not.toContain('search the Freshservice Solutions KB directly');
  });

  test('cost reduction: system prompt tells Claude to point the agent at the KB directly when no match was found', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }, { articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.system).toContain('search the Freshservice Solutions KB directly');
    expect(sentBody.system).not.toContain('SUGGESTED_KB_ARTICLE_START');
  });

  test('cost reduction: large categories (e.g. Application) are trimmed to keyword matches when the ticket names a real sub-category', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      ticketFieldsResponse: {
        ticket_fields: [
          { name: 'category', choices: [{
            value: 'Application',
            nested_options: Array.from({ length: 20 }, (_, i) => ({ value: `App${i}` }))
              .concat([{ value: 'KwikTag' }, { value: 'Other' }]),
          }] },
        ],
      },
    }) };
    const ticket = { id: 71805, subject: 'Error in KT', description_text: 'message in KwikTag keeps popping up' };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toContain('Application: KwikTag, Other');
    expect(sentBody.messages[0].content).not.toContain('App0');
  });

  test('cost reduction: a large category with no keyword hit in the ticket is sent unfiltered (no blind trimming)', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      ticketFieldsResponse: {
        ticket_fields: [
          { name: 'category', choices: [{
            value: 'Application',
            nested_options: Array.from({ length: 20 }, (_, i) => ({ value: `App${i}` })),
          }] },
        ],
      },
    }) };
    const ticket = { id: 71805, subject: 'Totally unrelated request', description_text: 'nothing app-specific here' };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.messages[0].content).toContain('App0');
    expect(sentBody.messages[0].content).toContain('App19');
  });

  test('category-validation reminder lands directly under the Category: line, not at the bottom', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText({
        body: 'Summary line.\n\nCategory: Network / Sub-Category: VPN\n\nNext steps follow.',
      }),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    const posted = JSON.parse(addNoteOpts.body).body;
    const categoryIdx = posted.indexOf('Category: Network / Sub-Category: VPN');
    const reminderIdx = posted.indexOf('confirm the actual issue matches before applying');
    const nextStepsIdx = posted.indexOf('Next steps follow');
    expect(categoryIdx).toBeGreaterThan(-1);
    expect(reminderIdx).toBeGreaterThan(categoryIdx);
    expect(reminderIdx).toBeLessThan(nextStepsIdx);
  });

  test('category-validation reminder falls back to the end of the note if Claude omits the Category: line entirely', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText({ body: 'Summary with no category line at all.' }),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    const posted = JSON.parse(addNoteOpts.body).body;
    expect(posted).toContain('confirm the actual issue matches before applying');
  });

  test('cost estimate: real usage token counts produce a computed $ figure in the completion log', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      claudeUsage: { input_tokens: 2000, output_tokens: 300 },
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const completionLine = logSpy.mock.calls.map((args) => args.join(' ')).find((line) => line.includes('[triage] ticket'));
    logSpy.mockRestore();
    // (2000 * $1 + 300 * $5) / 1e6 = $0.0035
    expect(completionLine).toContain('~$0.0035');
    expect(completionLine).toContain('tokens 2000in/300out');
  });

  test('note-posting failure: caught, does not throw', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }, { articles: [] }],
      claudeContent: claudeText(),
      addNoteError: new Error('freshservice down'),
    }) };
    await expect(
      server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams })
    ).resolves.not.toThrow();
  });

  test('Anthropic 429: retries up to 3 times and succeeds on the final attempt', async () => {
    vi.useFakeTimers();
    try {
      global.$request = { invokeTemplate: mockRequest({
        kbResponses: [{ articles: [] }],
        claudeResponses: [
          { status: 429 },
          { status: 429 },
          { status: 200, content: claudeText() },
        ],
      }) };
      const p = server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    const addNoteCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(addNoteCall).toBeDefined();
    const claudeCalls = global.$request.invokeTemplate.mock.calls.filter(([t]) => t === 'anthropicMessages');
    expect(claudeCalls).toHaveLength(3);
  });

  test('Anthropic 429 on all attempts: no note posted, does not throw', async () => {
    vi.useFakeTimers();
    try {
      global.$request = { invokeTemplate: mockRequest({
        kbResponses: [{ articles: [] }],
        claudeResponses: [{ status: 429 }],
      }) };
      const p = server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
      await vi.runAllTimersAsync();
      await expect(p).resolves.not.toThrow();
    } finally {
      vi.useRealTimers();
    }
    const addNoteCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(addNoteCall).toBeUndefined();
  });

  test('Anthropic non-200 response: no note posted, does not throw', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeStatus: 500,
      claudeContent: claudeText(),
    }) };
    await expect(
      server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams })
    ).resolves.not.toThrow();
    const addNoteCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(addNoteCall).toBeUndefined();
  });

  test('web search off by default: no tools array is sent', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.tools).toBeUndefined();
  });

  test('enable_web_search: sends the web_search tool with the default max_uses of 3', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: true } });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.tools).toEqual([
      { type: 'web_search_20260318', name: 'web_search', max_uses: 3, response_inclusion: 'excluded', allowed_callers: ['direct'] },
    ]);
  });

  test('web search on: the system prompt sanctions the tool and scopes when to use it', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: true } });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.system).toContain('You have a web_search tool');
  });

  test('web search off: the system prompt does not mention the web_search tool', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.system).not.toContain('web_search tool');
  });

  test('enable_web_search: web_search_max_uses overrides the default cap', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: true, web_search_max_uses: 5 } });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.tools[0].max_uses).toBe(5);
  });

  test('enable_web_search delivered as the STRING "true" (FDK checkbox) still turns web search on', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: 'true' } });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.tools).toBeDefined();
    expect(sentBody.tools[0].type).toBe('web_search_20260318');
  });

  test('enable_web_search delivered as the STRING "false" keeps web search off', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: 'false' } });
    const claudeCall = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'anthropicMessages');
    const sentBody = JSON.parse(claudeCall[1].body);
    expect(sentBody.tools).toBeUndefined();
  });

  test('web search citations: source URLs are rendered in the note and deduped, ignoring non-web citations', async () => {
    const content = [{
      type: 'text',
      text: 'Grounded answer.\nRELEVANT_KB_IDS: none',
      citations: [
        { type: 'web_search_result_location', url: 'https://vendor.example/doc', title: 'Vendor Doc' },
        { type: 'web_search_result_location', url: 'https://vendor.example/doc', title: 'Vendor Doc (dupe)' },
        { type: 'web_search_result_location', url: 'https://notitle.example/page' },
        { type: 'web_search_result_location', title: 'No URL here' },
        { type: 'char_location' },
      ],
    }];
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: content,
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: true } });
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    const posted = JSON.parse(addNoteOpts.body).body;
    expect(posted).toContain('Web sources:');
    expect(posted).toContain('href="https://vendor.example/doc"');
    // Deduped: the URL appears exactly once.
    expect(posted.match(/vendor\.example\/doc/g)).toHaveLength(1);
    // A citation with no title falls back to showing the URL as the link text.
    expect(posted).toContain('>https://notitle.example/page</a>');
    expect(posted).not.toContain('No URL here');
  });

  test('no web citations: the note omits the Web sources footer entirely', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: true } });
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(JSON.parse(addNoteOpts.body).body).not.toContain('Web sources:');
  });

  test('web search fee: web_search_requests adds $0.01 each and shows the count in the log', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      claudeUsage: { input_tokens: 3000, output_tokens: 400, server_tool_use: { web_search_requests: 2 } },
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: true } });
    const completionLine = logSpy.mock.calls.map((args) => args.join(' ')).find((line) => line.includes('[triage] ticket'));
    logSpy.mockRestore();
    // Haiku pinned in baseIparams: (3000*$1 + 400*$5)/1e6 = $0.005 tokens + 2*$0.01 = $0.025.
    expect(completionLine).toContain('~$0.0250');
    expect(completionLine).toContain('2 searches');
  });

  test('cost estimate on the Sonnet 5 default: $3/$15 standard pricing is applied', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      claudeUsage: { input_tokens: 2500, output_tokens: 500 },
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // No claude_model set -> resolveModel default of claude-sonnet-5.
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { freshservice_domain: 'example.freshservice.com', anthropic_api_key: 'sk-ant-test' } });
    const completionLine = logSpy.mock.calls.map((args) => args.join(' ')).find((line) => line.includes('[triage] ticket'));
    logSpy.mockRestore();
    // (2500*$3 + 500*$15)/1e6 = $0.0075 + $0.0075 = $0.0150.
    expect(completionLine).toContain('~$0.0150');
  });

  test('Sonnet 5 pricing: flat $3/$15 applies at any date', async () => {
    global.$request = { invokeTemplate: mockRequest({
      claudeContent: claudeText(),
      claudeUsage: { input_tokens: 1000000, output_tokens: 1000000 },
    }) };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:30:00Z'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, claude_model: 'claude-sonnet-5' } });
      const line = logSpy.mock.calls.map((a) => a.join(' ')).find((l) => l.includes('[triage] ticket'));
      expect(line).toContain('~$18.0000');   // 1M in @ $3 + 1M out @ $15
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('a model with flat pricing is unaffected by the date', async () => {
    global.$request = { invokeTemplate: mockRequest({
      claudeContent: claudeText(),
      claudeUsage: { input_tokens: 1000000, output_tokens: 1000000 },
    }) };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, claude_model: 'claude-haiku-4-5' } });
      const line = logSpy.mock.calls.map((a) => a.join(' ')).find((l) => l.includes('[triage] ticket'));
      expect(line).toContain('~$6.0000');    // 1M in @ $1 + 1M out @ $5, always
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('cost estimate: an unknown model yields "cost unknown"', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeContent: claudeText(),
      claudeUsage: { input_tokens: 100, output_tokens: 50 },
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, claude_model: 'claude-not-a-real-model' } });
    const completionLine = logSpy.mock.calls.map((args) => args.join(' ')).find((line) => line.includes('[triage] ticket'));
    logSpy.mockRestore();
    expect(completionLine).toContain('cost unknown');
  });

  test('web search pause_turn: resumes the paused turn, accumulates text/tokens, then posts once', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      claudeResponses: [
        { status: 200, content: [{ type: 'text', text: 'Partial before search.' }], usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: 'pause_turn' },
        { status: 200, content: claudeText({ body: 'Final grounded note.' }), usage: { input_tokens: 1500, output_tokens: 200 }, stop_reason: 'end_turn' },
      ],
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: true } });
    const completionLine = logSpy.mock.calls.map((args) => args.join(' ')).find((line) => line.includes('[triage] ticket'));
    logSpy.mockRestore();
    const claudeCalls = global.$request.invokeTemplate.mock.calls.filter(([t]) => t === 'anthropicMessages');
    expect(claudeCalls).toHaveLength(2);
    // Second request resumes with the assistant content from the first appended.
    const secondBody = JSON.parse(claudeCalls[1][1].body);
    expect(secondBody.messages).toHaveLength(2);
    expect(secondBody.messages[1].role).toBe('assistant');
    // Tokens summed across both rounds: 2500in / 300out.
    expect(completionLine).toContain('tokens 2500in/300out');
    const [, addNoteOpts] = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    expect(JSON.parse(addNoteOpts.body).body).toContain('Final grounded note.');
  });

  test('web search pause_turn: stops resuming after the continuation cap even if still paused', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [] }],
      // Always paused — the loop must stop itself at the cap (MAX+1 = 3 requests).
      claudeResponses: [
        { status: 200, content: claudeText(), usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'pause_turn' },
      ],
    }) };
    await expect(
      server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: { ...baseIparams, enable_web_search: true } })
    ).resolves.not.toThrow();
    const claudeCalls = global.$request.invokeTemplate.mock.calls.filter(([t]) => t === 'anthropicMessages');
    expect(claudeCalls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Microsoft Copilot provider tests (v1.8.0)
// ---------------------------------------------------------------------------

// Builds the plain text the Copilot provider returns: note body + RELEVANT_KB_IDS line.
function copilotText({ body = 'Note body.', relevantIds = 'none' } = {}) {
  return `${body}\nRELEVANT_KB_IDS: ${relevantIds}`;
}

describe('Microsoft Copilot provider (Azure OpenAI)', () => {
  beforeEach(() => {
    server = loadServerModule();
    global.$db = {
      get: vi.fn().mockRejectedValue({ message: 'not found' }),
      set: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
  });

  const copilotIparams = {
    freshservice_domain: 'example.freshservice.com',
    ai_provider: 'copilot',
    copilot_api_key: 'azure-key-test',
    copilot_endpoint_host: 'my-resource.openai.azure.com',
    copilot_deployment: 'gpt-4o-prod',
    copilot_api_version: '2025-01-01-preview',
    copilot_model: 'gpt-4o',
    output_budget: 512,
  };

  function callsTo(template) {
    return global.$request.invokeTemplate.mock.calls.filter(([t]) => t === template);
  }
  function postedNote() {
    const addNote = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    return addNote ? JSON.parse(addNote[1].body).body : null;
  }

  test('ai_provider "copilot" calls the Copilot template and never the Anthropic or OpenAI one', async () => {
    global.$request = { invokeTemplate: mockRequest({ copilotContent: copilotText() }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: copilotIparams });
    expect(callsTo('copilotChatCompletions')).toHaveLength(1);
    expect(callsTo('anthropicMessages')).toHaveLength(0);
    expect(callsTo('openaiResponses')).toHaveLength(0);
    expect(postedNote()).toContain('Note body.');
  });

  test('Copilot request body: chat completions shape with system message first, max_tokens, no model field', async () => {
    global.$request = { invokeTemplate: mockRequest({ copilotContent: copilotText() }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: copilotIparams });
    const sent = JSON.parse(callsTo('copilotChatCompletions')[0][1].body);
    expect(sent.max_tokens).toBe(512);
    expect(sent.model).toBeUndefined();
    expect(Array.isArray(sent.messages)).toBe(true);
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[1].role).toBe('user');
    // No reasoning or tools fields
    expect(sent.reasoning).toBeUndefined();
    expect(sent.tools).toBeUndefined();
  });

  test('missing copilot_api_key: no AI call, no note, and the error names the exact field', async () => {
    global.$request = { invokeTemplate: mockRequest({ copilotContent: copilotText() }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...copilotIparams, copilot_api_key: '' },
    });
    const logged = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(callsTo('copilotChatCompletions')).toHaveLength(0);
    expect(postedNote()).toBeNull();
    expect(logged).toContain('copilot_api_key is not set');
  });

  test('Copilot truncation is read from finish_reason "length"', async () => {
    global.$request = { invokeTemplate: mockRequest({
      copilotContent: copilotText(),
      copilotUsage: { prompt_tokens: 100, completion_tokens: 512 },
      copilotFinishReason: 'length',
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: copilotIparams });
    const line = logSpy.mock.calls.map((a) => a.join(' ')).find((l) => l.includes('[triage] ticket'));
    logSpy.mockRestore();
    expect(line).toContain('OUTPUT TRUNCATED');
  });

  test('Copilot cost estimate uses the Azure OpenAI pricing table', async () => {
    global.$request = { invokeTemplate: mockRequest({
      copilotContent: copilotText(),
      copilotUsage: { prompt_tokens: 2000, completion_tokens: 400 },
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: copilotIparams });
    const line = logSpy.mock.calls.map((a) => a.join(' ')).find((l) => l.includes('[triage] ticket'));
    logSpy.mockRestore();
    // (2000*$2.5 + 400*$10)/1e6 = $0.005 + $0.004 = $0.009
    expect(line).toContain('~$0.0090');
    expect(line).toContain('copilot/gpt-4o');
  });

  test('copilot_model overrides the provider default and affects cost calculation', async () => {
    global.$request = { invokeTemplate: mockRequest({
      copilotContent: copilotText(),
      copilotUsage: { prompt_tokens: 1000, completion_tokens: 200 },
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...copilotIparams, copilot_model: 'gpt-4o-mini' },
    });
    const line = logSpy.mock.calls.map((a) => a.join(' ')).find((l) => l.includes('[triage] ticket'));
    logSpy.mockRestore();
    // (1000*$0.15 + 200*$0.60)/1e6 = $0.00015 + $0.00012 = $0.00027
    expect(line).toContain('~$0.0003');
    expect(line).toContain('copilot/gpt-4o-mini');
  });

  test('Copilot web search is not attached even when enable_web_search is on', async () => {
    global.$request = { invokeTemplate: mockRequest({ copilotContent: copilotText() }) };
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...copilotIparams, enable_web_search: true },
    });
    const sent = JSON.parse(callsTo('copilotChatCompletions')[0][1].body);
    expect(sent.tools).toBeUndefined();
  });
});

// Recurring-ticket deflection (v1.1.0). Subjects/sub_category are the real shapes from
// production tickets #73369/#69313/#71751/#74220/#74291.
describe('recurring-ticket deflection', () => {
  // Runs a ticket through the handler and returns { posted, claudeCalled }.
  async function runDeflect(ticket, extraIparams = {}) {
    global.$request = { invokeTemplate: mockRequest({ kbResponses: [{ articles: [] }], claudeContent: claudeText() }) };
    await server.onTicketCreateHandler({ data: { ticket }, iparams: { ...baseIparams, ...extraIparams } });
    const calls = global.$request.invokeTemplate.mock.calls;
    const addNote = calls.find(([t]) => t === 'freshserviceAddNote');
    return {
      posted: addNote ? JSON.parse(addNote[1].body).body : null,
      claudeCalled: calls.some(([t]) => t === 'anthropicMessages'),
    };
  }

  test('admin consent request: deflects with the KB link and the generic ack canned response, no AI call', async () => {
    const { posted, claudeCalled } = await runDeflect({
      id: 73369,
      subject: "[EXT]  Action required: Review Caylin Blackford's admin consent request for Tableau Online (prod)",
    });
    expect(claudeCalled).toBe(false);
    expect(posted).toContain('Auto-response (Admin consent request)');
    expect(posted).toContain('href="https://example.freshservice.com/a/solutions/articles/38000009779"');
    expect(posted).toContain("We've received your request");
  });

  test('quarantine release: matches on subject wording, no AI call', async () => {
    const { posted, claudeCalled } = await runDeflect({
      id: 69313,
      subject: '[EXT]  Informational-severity alert: User requested to release a quarantined message',
    });
    expect(claudeCalled).toBe(false);
    expect(posted).toContain('Auto-response (Quarantine release)');
    expect(posted).toContain('Quarantine Release');
  });

  test('quarantine release: also matches on the sub_category signal alone', async () => {
    const { posted, claudeCalled } = await runDeflect({
      id: 69999,
      subject: 'a subject that does not mention quarantine at all',
      sub_category: 'Quarantine Release',
    });
    expect(claudeCalled).toBe(false);
    expect(posted).toContain('Auto-response (Quarantine release)');
  });

  test('SQM quarterly maintenance: deflects on the "SQM -" subject with an internal-only note', async () => {
    const { posted, claudeCalled } = await runDeflect({ id: 71751, subject: 'SQM - pE-Jumpbox01' });
    expect(claudeCalled).toBe(false);
    expect(posted).toContain('Auto-response (Server Quarterly Maintenance)');
    expect(posted).toContain('href="https://example.freshservice.com/a/solutions/articles/38000020150"');
    expect(posted).toContain('internal handling only');
  });

  test('SQM: still deflects when the subject carries a leading prefix ([SMOKE TEST], [EXT], Fw:)', async () => {
    for (const subject of ['[SMOKE TEST] SQM - pE-Jumpbox01', '[EXT] SQM - host1', 'Fw: SQM - host2']) {
      const { claudeCalled } = await runDeflect({ id: 71751, subject });
      expect(claudeCalled).toBe(false);
    }
    // But a mid-word "SQM" must NOT match (no false positive).
    const { claudeCalled } = await runDeflect({ id: 999, subject: 'MYSQM-1 alert about something' });
    expect(claudeCalled).toBe(true);
  });

  test('Box/OneDrive links: the "Termination - Shared File Links" subject deflects to the Box template, not termination', async () => {
    const { posted, claudeCalled } = await runDeflect({
      id: 74220,
      subject: 'Daniel Ammon - 09/04/2026 - Termination - Shared File Links for Box/OneDrive',
    });
    expect(claudeCalled).toBe(false);
    expect(posted).toContain('Auto-response (Box/OneDrive shared links)');
    expect(posted).not.toContain('Auto-response (Employee termination)');
    expect(posted).toContain('Offboarding - Shared Links');
  });

  test('employee termination: the notification subject deflects to the termination template', async () => {
    const { posted, claudeCalled } = await runDeflect({
      id: 74291,
      subject: '[EXT]  Employee Termination Notification-Andrew Hamilton-08/15/2026',
    });
    expect(claudeCalled).toBe(false);
    expect(posted).toContain('Auto-response (Employee termination)');
    expect(posted).toContain('href="https://example.freshservice.com/a/solutions/articles/38000030214"');
    expect(posted).toContain('internal handling only');
  });

  test('enable_deflection false: a matching ticket is sent through AI triage instead of deflected', async () => {
    const { posted, claudeCalled } = await runDeflect(
      { id: 71751, subject: 'SQM - pE-Jumpbox01' },
      { enable_deflection: false }
    );
    expect(claudeCalled).toBe(true);
    expect(posted).not.toContain('Auto-response');
  });

  test('enable_deflection delivered as the STRING "false" (FDK checkbox) also disables deflection', async () => {
    const { claudeCalled } = await runDeflect(
      { id: 71751, subject: 'SQM - pE-Jumpbox01' },
      { enable_deflection: 'false' }
    );
    expect(claudeCalled).toBe(true);
  });

  test('PoC gate takes precedence over deflection: a gated-out matching ticket posts nothing', async () => {
    global.$request = { invokeTemplate: mockRequest({ kbResponses: [{ articles: [] }], claudeContent: claudeText() }) };
    await server.onTicketCreateHandler({
      data: { ticket: { id: 71751, subject: 'SQM - pE-Jumpbox01', group_id: 1 } },
      iparams: { ...baseIparams, poc_group_id: 999 },
    });
    expect(global.$request.invokeTemplate).not.toHaveBeenCalled();
  });

  test('deflection: writes a log entry with deflected:true and deflect_type to report storage', async () => {
    global.$db = {
      get: vi.fn().mockRejectedValue({ message: 'not found' }),
      set: vi.fn().mockResolvedValue({}),
    };
    await runDeflect({ id: 73369, subject: "[EXT]  Action required: Review someone's admin consent request" });
    const bucketWrite = global.$db.set.mock.calls.find(
      ([key, val]) => key.startsWith('triage_d_') && val.entries && val.entries[0].deflected === true
    );
    expect(bucketWrite).toBeDefined();
    expect(bucketWrite[1].entries[0].deflect_type).toBe('admin_consent');
    expect(bucketWrite[1].entries[0].cost_usd).toBe(0);
    expect(bucketWrite[1].entries[0].input_tokens).toBe(0);
  });

  test('non-matching ticket: falls through to normal AI triage', async () => {
    const { claudeCalled } = await runDeflect({ id: 1, subject: 'Printer on 3rd floor is jammed' });
    expect(claudeCalled).toBe(true);
  });
});

describe('provider swapping (Anthropic <-> OpenAI)', () => {
  beforeEach(() => {
    server = loadServerModule();
    global.$db = {
      get: vi.fn().mockRejectedValue({ message: 'not found' }),
      set: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
  });

  // Mirrors baseIparams but selects the OpenAI provider. openai_model is deliberately
  // left unset in most tests so the provider's own default is exercised.
  const openaiIparams = {
    freshservice_domain: 'example.freshservice.com',
    ai_provider: 'openai',
    openai_api_key: 'sk-openai-test',
    openai_host: 'api.openai.com',
    output_budget: 512,
  };

  function callsTo(template) {
    return global.$request.invokeTemplate.mock.calls.filter(([t]) => t === template);
  }

  function postedNote() {
    const addNote = global.$request.invokeTemplate.mock.calls.find(([t]) => t === 'freshserviceAddNote');
    return addNote ? JSON.parse(addNote[1].body).body : null;
  }

  test('ai_provider "openai" calls the OpenAI template and never the Anthropic one', async () => {
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: openaiOutput() }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    expect(callsTo('openaiResponses')).toHaveLength(1);
    expect(callsTo('anthropicMessages')).toHaveLength(0);
    expect(postedNote()).toContain('Note body.');
  });

  test('ai_provider unset still routes to Anthropic, so existing installs are unaffected', async () => {
    global.$request = { invokeTemplate: mockRequest({ claudeContent: claudeText() }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
    expect(callsTo('anthropicMessages')).toHaveLength(1);
    expect(callsTo('openaiResponses')).toHaveLength(0);
  });

  test('an unknown ai_provider falls back to Anthropic rather than dropping the ticket', async () => {
    global.$request = { invokeTemplate: mockRequest({ claudeContent: claudeText() }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...baseIparams, ai_provider: 'gemini' },
    });
    const logged = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(callsTo('anthropicMessages')).toHaveLength(1);
    expect(logged).toContain('unknown ai_provider "gemini"');
    expect(postedNote()).toContain('Note body.');
  });

  test('OpenAI request body: Responses API shape, with reasoning disabled to protect the output budget', async () => {
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: openaiOutput() }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    const sent = JSON.parse(callsTo('openaiResponses')[0][1].body);
    expect(sent.model).toBe('gpt-5.6-terra');
    expect(sent.max_output_tokens).toBe(512);
    // GPT-5 reasoning tokens bill against max_output_tokens; leaving this on can consume
    // the whole 512-token budget and return an empty note.
    expect(sent.reasoning).toEqual({ effort: 'none' });
    expect(sent.instructions).toContain('IT service-desk triage assistant');
    expect(sent.input[0].role).toBe('user');
    expect(sent.input[0].content).toContain('Cannot connect to VPN');
    // No web search configured -> the tools key is omitted entirely.
    expect(sent.tools).toBeUndefined();
  });

  test('openai_model overrides the provider default', async () => {
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: openaiOutput() }) };
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...openaiIparams, openai_model: 'gpt-5.6-luna' },
    });
    expect(JSON.parse(callsTo('openaiResponses')[0][1].body).model).toBe('gpt-5.6-luna');
  });

  test('missing openai_api_key: no AI call, no note, and the error names the exact field', async () => {
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: openaiOutput() }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...openaiIparams, openai_api_key: '' },
    });
    const logged = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(callsTo('openaiResponses')).toHaveLength(0);
    expect(postedNote()).toBeNull();
    expect(logged).toContain('openai_api_key is not set');
  });

  test('missing anthropic_api_key is caught the same way', async () => {
    global.$request = { invokeTemplate: mockRequest({ claudeContent: claudeText() }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { freshservice_domain: 'example.freshservice.com', ai_provider: 'anthropic' },
    });
    const logged = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(callsTo('anthropicMessages')).toHaveLength(0);
    expect(logged).toContain('anthropic_api_key is not set');
  });

  test('OpenAI web search: attaches the built-in tool and renders cited sources in the note', async () => {
    global.$request = { invokeTemplate: mockRequest({
      openaiOutput: openaiOutput({
        body: 'Grounded in a vendor advisory.',
        searchActions: ['search'],
        annotations: [
          { type: 'url_citation', url: 'https://vendor.example/advisory', title: 'Vendor advisory' },
          { type: 'url_citation', url: 'https://vendor.example/advisory', title: 'Vendor advisory' },
        ],
      }),
    }) };
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...openaiIparams, enable_web_search: true },
    });
    const sent = JSON.parse(callsTo('openaiResponses')[0][1].body);
    expect(sent.tools).toEqual([{ type: 'web_search' }]);
    const note = postedNote();
    expect(note).toContain('<b>Web sources:</b>');
    // Deduped by URL, so the repeated citation appears exactly once.
    expect(note.match(/vendor\.example\/advisory/g)).toHaveLength(1);
  });

  // Live on sandbox INC-4053 (2026-08-27): a searching turn returned 1 web_search_call,
  // 12,598 input tokens — and ZERO url_citation annotations. The note asserted a specific
  // Microsoft KB number as current fact with no link. Annotations are the model's choice
  // and are not guaranteed, so the consulted-sources list is the safety net.
  test('web search with NO citations falls back to consulted sources, labelled honestly', async () => {
    const output = openaiOutput({ body: 'Grounded but unattributed.' });
    output.unshift({
      type: 'web_search_call',
      status: 'completed',
      action: {
        type: 'search',
        sources: [{ url: 'https://support.microsoft.com/kb5121003', title: 'KB5121003' }],
      },
    });
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: output }) };
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...openaiIparams, enable_web_search: true },
    });
    const note = postedNote();
    expect(note).toContain('Sources consulted');
    expect(note).toContain('nothing was explicitly cited');
    expect(note).toContain('kb5121003');
    // Must NOT claim a citation the model never made.
    expect(note).not.toContain('<b>Web sources:</b>');
  });

  test('consulted sources are capped, deduped across query strings, and the remainder counted', async () => {
    const many = [];
    for (let i = 1; i <= 8; i++) many.push({ type: 'url', url: `https://example.com/page${i}` });
    // Same page twice, once with a tracking query — one search returned exactly this live.
    many.push({ type: 'url', url: 'https://example.com/page1?utm_source=openai' });

    const output = openaiOutput({ body: 'Unattributed.' });
    output.unshift({ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: many } });
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: output }) };
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...openaiIparams, enable_web_search: true },
    });
    const note = postedNote();
    // 9 raw -> 8 unique after stripping the query string -> 5 shown, 3 counted.
    // Count anchors, not URL occurrences: sources have no title, so the URL is also the
    // link text and each one appears twice in the markup.
    expect((note.match(/<a href="https:\/\/example\.com\/page/g) || []).length).toBe(5);
    expect(note).toContain('(+3 more consulted)');
    expect(note).not.toContain('utm_source');
  });

  test('a real citation still wins over the consulted-sources fallback', async () => {
    const output = openaiOutput({
      body: 'Grounded and attributed.',
      annotations: [{ type: 'url_citation', url: 'https://vendor.example/cited', title: 'Cited page' }],
    });
    output.unshift({
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', sources: [{ url: 'https://vendor.example/merely-consulted', title: 'Consulted' }] },
    });
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: output }) };
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...openaiIparams, enable_web_search: true },
    });
    const note = postedNote();
    expect(note).toContain('<b>Web sources:</b>');
    expect(note).toContain('vendor.example/cited');
    expect(note).not.toContain('Sources consulted');
  });

  test('the consulted-sources include is only requested when search is on', async () => {
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: openaiOutput() }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    const sent = JSON.parse(callsTo('openaiResponses')[0][1].body);
    expect(sent.include).toBeUndefined();

    global.$request = { invokeTemplate: mockRequest({ openaiOutput: openaiOutput() }) };
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...openaiIparams, enable_web_search: true },
    });
    const sent2 = JSON.parse(callsTo('openaiResponses')[0][1].body);
    expect(sent2.include).toEqual(['web_search_call.action.sources']);
  });

  test('OpenAI web-search billing: only `search` actions count, not open_page/find_in_page', async () => {
    global.$request = { invokeTemplate: mockRequest({
      openaiOutput: openaiOutput({ searchActions: ['search', 'open_page', 'find_in_page', 'search'] }),
      openaiUsage: { input_tokens: 1000, output_tokens: 200 },
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({
      data: { ticket: baseTicket },
      iparams: { ...openaiIparams, enable_web_search: true },
    });
    const line = logSpy.mock.calls.map((a) => a.join(' ')).find((l) => l.includes('[triage] ticket'));
    logSpy.mockRestore();
    // 2 billable searches, not 4.
    expect(line).toContain('2 searches');
    // gpt-5.6-terra = $2/$12 per Mtok -> (1000*2 + 200*12)/1e6 = $0.0044, + 2 * $0.01 = $0.0244.
    expect(line).toContain('~$0.0244');
  });

  test('OpenAI cost estimate uses the OpenAI pricing table', async () => {
    global.$request = { invokeTemplate: mockRequest({
      openaiOutput: openaiOutput(),
      openaiUsage: { input_tokens: 2500, output_tokens: 500 },
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    const line = logSpy.mock.calls.map((a) => a.join(' ')).find((l) => l.includes('[triage] ticket'));
    logSpy.mockRestore();
    // (2500*$2 + 500*$12)/1e6 = $0.005 + $0.006 = $0.011.
    expect(line).toContain('~$0.0110');
    expect(line).toContain('openai/gpt-5.6-terra');
  });

  test('OpenAI truncation is read from incomplete_details, not stop_reason', async () => {
    global.$request = { invokeTemplate: mockRequest({
      openaiOutput: openaiOutput(),
      openaiUsage: { input_tokens: 100, output_tokens: 512 },
      openaiIncompleteReason: 'max_output_tokens',
    }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    const line = logSpy.mock.calls.map((a) => a.join(' ')).find((l) => l.includes('[triage] ticket'));
    logSpy.mockRestore();
    expect(line).toContain('OUTPUT TRUNCATED');
  });

  test('OpenAI: a non-200 response is thrown and logged, and no note is posted', async () => {
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: openaiOutput(), openaiStatus: 401 }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    const logged = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(logged).toContain('OpenAI ChatGPT API error: HTTP 401');
    expect(postedNote()).toBeNull();
  });

  test('the report log entry records provider and model so runs can be compared', async () => {
    global.$request = { invokeTemplate: mockRequest({
      openaiOutput: openaiOutput(),
      openaiUsage: { input_tokens: 100, output_tokens: 50 },
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    // The writer is append-first: $db.update(key, 'append', {entries:[entry]}) succeeds
    // here, so the entry lands in the update() payload and $db.set is never reached.
    const appendCall = global.$db.update.mock.calls.find(
      ([key, op]) => key.startsWith('triage_d_') && op === 'append'
    );
    const entry = appendCall[2].entries[0];
    expect(entry.provider).toBe('openai');
    expect(entry.model).toBe('gpt-5.6-terra');
  });

  test('OpenAI: an empty output array posts no note rather than a blank one', async () => {
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: [] }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    const logged = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(postedNote()).toBeNull();
    expect(logged).toContain('empty openai response');
  });

  test('OpenAI still gets KB grounding and the deterministic KB footer', async () => {
    global.$request = { invokeTemplate: mockRequest({
      kbResponses: [{ articles: [{ id: 42, title: 'VPN troubleshooting', description: 'steps' }] }],
      openaiOutput: openaiOutput({ relevantIds: '42' }),
    }) };
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    const sent = JSON.parse(callsTo('openaiResponses')[0][1].body);
    expect(sent.input[0].content).toContain('VPN troubleshooting');
    expect(postedNote()).toContain('href="https://example.freshservice.com/a/solutions/articles/42"');
  });

  // A quota 429 and a rate-limit 429 are the same status code and need opposite handling.
  // Retrying an exhausted credit balance can never succeed and costs ~3s of the 20s
  // execution budget per ticket, at exactly the moment triage is already failing.
  const QUOTA_429_BODY = JSON.stringify({
    error: {
      message: 'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
      type: 'insufficient_quota',
      code: 'credit_balance_exhausted',
    },
  });

  test('quota-exhausted 429 fails FAST: called exactly once, no retries', async () => {
    vi.useFakeTimers();
    try {
      global.$request = { invokeTemplate: mockRequest({
        openaiStatus: 429,
        openaiRawResponse: QUOTA_429_BODY,
      }) };
      const p = server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
      await vi.runAllTimersAsync();
      await expect(p).resolves.not.toThrow();
    } finally {
      vi.useRealTimers();
    }
    expect(callsTo('openaiResponses')).toHaveLength(1);
    expect(postedNote()).toBeNull();
  });

  test('quota-exhausted 429 logs what to DO about it, not a bare HTTP 429', async () => {
    global.$request = { invokeTemplate: mockRequest({
      openaiStatus: 429,
      openaiRawResponse: QUOTA_429_BODY,
    }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
    const logged = errSpy.mock.calls.map((a) => a.join(' ')).join('\n');
    errSpy.mockRestore();
    expect(logged).toContain('credit balance exhausted');
    expect(logged).toContain('add credits');
  });

  test('a genuine rate-limit 429 (no quota wording) is still retried three times', async () => {
    vi.useFakeTimers();
    try {
      global.$request = { invokeTemplate: mockRequest({
        openaiStatus: 429,
        openaiRawResponse: JSON.stringify({
          error: { message: 'Rate limit reached for gpt-5.6-terra', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
        }),
      }) };
      const p = server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: openaiIparams });
      await vi.runAllTimersAsync();
      await expect(p).resolves.not.toThrow();
    } finally {
      vi.useRealTimers();
    }
    // Unchanged behaviour for the transient case — this is the regression guard that the
    // fast-fail above didn't disable retrying altogether.
    expect(callsTo('openaiResponses')).toHaveLength(3);
  });

  test('Anthropic credit exhaustion is caught by the same guard', async () => {
    vi.useFakeTimers();
    try {
      global.$request = { invokeTemplate: mockRequest({
        claudeResponses: [{ status: 429, content: [{ type: 'text', text: 'Your credit balance is too low to access the Anthropic API.' }] }],
      }) };
      const p = server.onTicketCreateHandler({ data: { ticket: baseTicket }, iparams: baseIparams });
      await vi.runAllTimersAsync();
      await expect(p).resolves.not.toThrow();
    } finally {
      vi.useRealTimers();
    }
    expect(callsTo('anthropicMessages')).toHaveLength(1);
  });

  test('deflection still short-circuits before any OpenAI call', async () => {
    global.$request = { invokeTemplate: mockRequest({ openaiOutput: openaiOutput() }) };
    await server.onTicketCreateHandler({
      data: { ticket: { id: 73369, subject: 'Action required: Review an admin consent request for Tableau' } },
      iparams: openaiIparams,
    });
    expect(callsTo('openaiResponses')).toHaveLength(0);
    expect(postedNote()).toContain('Auto-response (Admin consent request)');
  });
});
