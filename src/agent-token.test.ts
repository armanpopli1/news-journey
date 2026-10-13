import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { once } from 'node:events';
import { CODE_ROOT, atomicJson, authenticate, authorize, issueAgentToken, issueMember, members, read, updateMember } from './workspaces.js';
import { createControlServer } from './control.js';
import { applyExecutiveAction } from './executive-actions.js';
import { connectionId, connectionPath, loadConnection } from './connector-hosts.js';
import { disconnectConnection, embeddedConnector, selfServeConnection } from './connector-local.js';
import { callHarnessTool, harnessApi, pendingConfirmations } from './connector-tools.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const owner = 'a'.repeat(64), viewer = 'b'.repeat(64), editor = 'c'.repeat(64);

/** A throwaway workspace whose owner is `local-owner`, as createWorkspace makes it. */
function fixture() {
  mkdirSync(join(CODE_ROOT, 'workspaces'), { recursive: true });
  const root = mkdtempSync(join(CODE_ROOT, 'workspaces/agent-token-')), workspace = basename(root);
  cpSync(join(CODE_ROOT, 'config'), join(root, 'config'), { recursive: true });
  for (const d of ['state', 'workdir/videos', 'workdir/newsletters', 'workdir/harvest']) mkdirSync(join(root, d), { recursive: true });
  atomicJson(join(root, 'workspace.json'), { id: workspace, name: 'Agent token fixture' });
  atomicJson(join(root, 'desks.json'), { news: { editions: ['news-edition'], channels: ['youtube'] } });
  atomicJson(join(root, 'members.json'), [
    { id: 'local-owner', role: 'owner', tokenHash: sha(owner) },
    { id: 'reader', role: 'viewer', tokenHash: sha(viewer) },
    { id: 'desk-editor', role: 'editor', desks: ['news'], tokenHash: sha(editor) },
  ]);
  return { root, workspace, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function control() {
  const f = fixture(), calls: any[] = [];
  const server = createControlServer({ mutate: async (_root, token, input) => { calls.push({ token, input }); return { prepared: true }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  return { ...f, base, calls, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); } };
}
/** Run `fn` as a worker would: the process holds one member token and one workspace. */
async function asWorker<T>(f: { workspace: string }, token: string, fn: () => Promise<T>): Promise<T> {
  const prior = { token: process.env.HARNESS_TOKEN, workspace: process.env.HARNESS_WORKSPACE };
  process.env.HARNESS_TOKEN = token; process.env.HARNESS_WORKSPACE = f.workspace;
  try { return await fn(); }
  finally { for (const [key, value] of [['HARNESS_TOKEN', prior.token], ['HARNESS_WORKSPACE', prior.workspace]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test('a connection stores a scoped agent token, never the member token', () => {
  const f = fixture();
  try {
    const c = selfServeConnection(f.root, 'claude', owner);
    assert.notEqual(c.token, owner);
    const actor = authenticate(f.root, c.token);
    assert.equal(actor.id, 'local-owner'); assert.equal(actor.role, 'agent');
    assert.ok(!readFileSync(connectionPath(f.root, c.id), 'utf8').includes(owner));
    assert.deepEqual(members(f.root).filter(m => m.role === 'agent').map(m => [m.id, m.issuer]), [['connection-' + c.id, 'local-owner']]);
    // A second launch reuses the connection and its credential.
    assert.equal(selfServeConnection(f.root, 'claude', owner).token, c.token);
  } finally { f.cleanup(); }
});

test('over HTTP the agent token reads and drafts but cannot approve, automate, manage access or confirm for a human', async () => {
  const c = await control();
  try {
    const conn = selfServeConnection(c.root, 'claude', owner), token = conn.token;
    atomicJson(join(c.root, 'workdir/videos/20260101-pkg/meta.json'), { id: '20260101-pkg', edition: 'daily-roundup', status: 'pending_review', createdBy: 'local-owner' });
    let n = 0;
    const call = (method: string, path: string, body?: unknown, human = false) => fetch(c.base + path + '?workspace=' + c.workspace, {
      method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'idempotency-key': 'agent-key-' + ++n, ...(human ? { origin: c.base, 'x-harness-human': 'click' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal((await call('GET', '/v1/journey')).status, 200);
    assert.equal((await call('GET', '/v1/state')).status, 200);
    assert.equal((await call('POST', '/v1/journey/draft', { edition: 'daily-roundup' })).status, 202); assert.equal(c.calls.length, 1);
    for (const [path, body] of [['/v1/journey/automation', { mode: 'auto' }], ['/v1/journey/member-add', { memberId: 'x', role: 'admin', desks: '' }], ['/v1/journey/persona', {}], ['/v1/journey/publish-newsletter', { id: '20260101-pkg' }], ['/v1/packages/20260101-pkg/approve', { expectedHash: 'f'.repeat(64) }]] as const) {
      assert.equal((await call('POST', path, body, true)).status, 403, path);
    }
    assert.equal(c.calls.length, 1);
    // A forged click header cannot turn the agent's own review request into a human decision.
    const ctx = { root: c.root, token, api: harnessApi(c.base, c.workspace, token), connection: 'test-agent' };
    await callHarnessTool(ctx, 'harness_request_confirmation', { action: { operation: 'member-disable', memberId: 'reader' }, requestId: 'agent-review-1' });
    const [pending] = pendingConfirmations(c.root);
    assert.equal((await call('POST', '/v1/connectors/review', { id: pending.id, expectedHash: pending.hash, allow: true }, true)).status, 403);
    assert.equal(members(c.root).find(m => m.id === 'reader')?.disabled, undefined);
  } finally { await c.close(); }
});

test('a connected agent may save setup settings but not a writer, credential or another voice', async () => {
  const f = fixture();
  try {
    const { token } = selfServeConnection(f.root, 'claude', owner);
    await asWorker(f, token, async () => {
      const brief = { publication: 'Weekly AI', audience: 'Engineers', topics: 'AI' };
      await assert.rejects(applyExecutiveAction('publication', brief), /Forbidden: a connected agent keeps the saved writer/);
      await assert.rejects(applyExecutiveAction('publication', { ...brief, preserveModel: true, apiKey: 'sk-secret-value' }), /Forbidden/);
      await assert.rejects(applyExecutiveAction('media', { voiceProvider: 'elevenlabs', mode: 'cards', voiceKey: 'secret-voice-key' }), /Forbidden/);
      await assert.rejects(applyExecutiveAction('media', { voiceProvider: 'voicebox', voiceProfile: 'someone-else', mode: 'cards' }), /Forbidden: select your voice profile/);
      await assert.rejects(applyExecutiveAction('personalize', { logoPath: '/etc/passwd' }), /Forbidden/);
      for (const operation of ['channels', 'channel', 'writer', 'automation', 'member-add']) await assert.rejects(applyExecutiveAction(operation, {}), /Forbidden/, operation);
      assert.match((await applyExecutiveAction('media', { voiceProvider: 'kokoro', mode: 'cards' })).message as string, /saved/);
      assert.equal(read<any>(join(f.root, 'config/avatar.json'), {}).voiceProvider, 'kokoro');
      await applyExecutiveAction('editorial', { topics: 'AI', avoid: '', notes: '', feeds: '', enabledSources: ['hn'] });
      assert.deepEqual(read<any>(join(f.root, 'config/sources.json'), {}).editorial.preferredTopics, ['AI']);
    });
  } finally { f.cleanup(); }
});

test('a saved writer outside the setup schema (antigravity) still lets the agent save its publication', async () => {
  const f = fixture();
  try {
    const modelFile = join(f.root, 'config/model.json'), model = read<any>(modelFile, {});
    atomicJson(modelFile, { ...model, provider: 'antigravity', providers: { ...model.providers, antigravity: { ...model.providers?.antigravity } } });
    const { token } = selfServeConnection(f.root, 'claude', owner);
    await asWorker(f, token, async () => {
      await applyExecutiveAction('publication', { publication: 'Weekly AI', audience: 'Engineers', topics: 'AI', model: 'antigravity', modelName: '', modelUrl: '', preserveModel: true });
    });
    assert.equal(read<any>(modelFile, {}).provider, 'antigravity');
    assert.equal(read<any>(join(f.root, 'state/journey-brief.json'), {}).publication, 'Weekly AI');
  } finally { f.cleanup(); }
});

test('an agent holds only what its issuer may do, within the issuer desks', () => {
  const f = fixture();
  try {
    const asEditor = authenticate(f.root, issueAgentToken(f.root, { id: 'desk-editor', role: 'editor' }, 'claude-editor'));
    assert.deepEqual([asEditor.id, asEditor.role], ['desk-editor', 'agent']);
    assert.equal(authorize('produce', { root: f.root, actor: asEditor, edition: 'news-edition' }).id, 'desk-editor');
    assert.throws(() => authorize('produce', { root: f.root, actor: asEditor, edition: 'daily-roundup' }), /outside your assigned desks/);
    assert.throws(() => authorize('configure', { root: f.root, actor: asEditor }), /Forbidden/); // an editor cannot configure, so neither can its agent
    assert.throws(() => authorize('approve', { root: f.root, actor: asEditor, edition: 'news-edition', author: 'someone' }), /Forbidden/);
    const asViewer = authenticate(f.root, issueAgentToken(f.root, { id: 'reader', role: 'viewer' }, 'claude-viewer'));
    assert.equal(authorize('read', { root: f.root, actor: asViewer }).id, 'reader');
    assert.throws(() => authorize('produce', { root: f.root, actor: asViewer, edition: 'news-edition' }), /Forbidden/);
    // A demotion takes effect on the next call.
    const asOwner = authenticate(f.root, issueAgentToken(f.root, { id: 'local-owner', role: 'owner' }, 'claude-owner'));
    authorize('configure', { root: f.root, actor: asOwner });
    const rows = members(f.root); rows.find(m => m.id === 'local-owner')!.role = 'viewer'; atomicJson(join(f.root, 'members.json'), rows);
    assert.throws(() => authorize('configure', { root: f.root, actor: asOwner }), /Forbidden/);
  } finally { f.cleanup(); }
});

test('disconnect deletes the agent credential and disabling the issuer stops it', async () => {
  const f = fixture();
  try {
    const c = selfServeConnection(f.root, 'claude', owner);
    assert.ok(authenticate(f.root, c.token));
    await disconnectConnection(f.root, 'claude', owner);
    assert.deepEqual(members(f.root).filter(m => m.role === 'agent'), []);
    assert.throws(() => authenticate(f.root, c.token), /Unauthorized/);
    assert.throws(() => loadConnection(f.root, c.id), /Unauthorized/);
    // Reconnecting issues a different credential.
    const again = selfServeConnection(f.root, 'claude', owner); assert.notEqual(again.token, c.token); assert.ok(authenticate(f.root, again.token));
    const rows = members(f.root); rows.find(m => m.id === 'local-owner')!.disabled = true; atomicJson(join(f.root, 'members.json'), rows);
    assert.throws(() => authenticate(f.root, again.token), /Unauthorized/);
  } finally { f.cleanup(); }
});

test('a connection that still holds the member token is scoped in place and keeps its generation', async () => {
  const f = fixture();
  try {
    const first = selfServeConnection(f.root, 'claude', owner), id = connectionId('claude', 'local-owner');
    assert.equal(first.id, id);
    atomicJson(connectionPath(f.root, id), { ...first, token: owner }); // as written before agents held their own token
    atomicJson(join(f.root, 'members.json'), members(f.root).filter(m => m.role !== 'agent'));
    const embedded = await embeddedConnector(f.root, id, first.generation);
    try {
      const saved = loadConnection(f.root, id);
      assert.equal(saved.generation, first.generation); assert.notEqual(saved.token, owner); assert.equal(authenticate(f.root, saved.token).role, 'agent');
      assert.ok(!readFileSync(connectionPath(f.root, id), 'utf8').includes(owner));
      assert.ok(await callHarnessTool(embedded.context, 'harness_status', {}));
    } finally { embedded.close(); }
    // A launcher that already holds the old generation keeps working, and a stale generation does not.
    await assert.rejects(embeddedConnector(f.root, id, 'f'.repeat(32)), /Unauthorized/);
  } finally { f.cleanup(); }
});

test('an invite or role patch can never produce an agent', async () => {
  const f = fixture();
  try {
    const { id } = selfServeConnection(f.root, 'claude', owner);
    await asWorker(f, owner, async () => {
      assert.throws(() => issueMember(f.root, 'sneaky', 'agent'), /agent credentials cannot be granted/);
      assert.throws(() => updateMember(f.root, 'reader', { role: 'agent' }), /follows its issuer/);
      assert.throws(() => updateMember(f.root, 'connection-' + id, { role: 'viewer' }), /follows its issuer/);
      assert.throws(() => updateMember(f.root, 'connection-' + id, { desks: ['news'] }), /follows its issuer/);
      updateMember(f.root, 'connection-' + id, { disabled: true }); // switching one off stays possible
    });
    assert.equal(members(f.root).find(m => m.id === 'reader')?.role, 'viewer');
    assert.equal(members(f.root).find(m => m.id === 'connection-' + id)?.disabled, true);
  } finally { f.cleanup(); }
});
