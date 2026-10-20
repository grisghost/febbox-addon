'use strict';

process.env.CONFIG_SECRET = 'test-secret-at-least-16-chars';
process.env.TMDB_API_KEY = 'fake-tmdb-key';

const nock = require('nock');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { encodeConfigToken } = require('../../src/config/configToken');
const { catalogCache, playbackCache } = require('../../src/cache/ttlCache');
const { registry } = require('../../src/admin/registry');
const tokenPool = require('../../src/providers/febbox/tokenPool');

const SECRET = process.env.CONFIG_SECRET;
const PASSWORD = 'correct-horse-battery';

/** Log in and return the session cookie to send on later requests. */
async function login(app, password = PASSWORD) {
  const resp = await request(app).post('/api/admin/login').set('X-Admin-Request', '1').send({ password });
  return { resp, cookie: (resp.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ') };
}

describe('admin area', () => {
  let app;
  beforeAll(() => {
    app = createApp();
  });
  afterEach(() => {
    delete process.env.ADMIN_PASSWORD;
  });

  test('session endpoint reports disabled when ADMIN_PASSWORD is not set; admin API answers 404', async () => {
    const session = await request(app).get('/api/admin/session');
    expect(session.body).toEqual({ enabled: false, authenticated: false });
    const overview = await request(app).get('/api/admin/overview');
    expect(overview.status).toBe(404);
  });

  test('admin API requires a signed-in session', async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const resp = await request(app).get('/api/admin/overview');
    expect(resp.status).toBe(401);
  });

  test('login rejects a wrong password and accepts the right one with an HttpOnly SameSite cookie', async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const bad = await login(app, 'nope');
    expect(bad.resp.status).toBe(401);
    expect(bad.cookie).toBe('');

    const good = await login(app);
    expect(good.resp.status).toBe(200);
    const raw = good.resp.headers['set-cookie'][0];
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Strict/);

    const session = await request(app).get('/api/admin/session').set('Cookie', good.cookie);
    expect(session.body.authenticated).toBe(true);
  });

  test('login needs the X-Admin-Request header', async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const resp = await request(app).post('/api/admin/login').send({ password: PASSWORD });
    expect(resp.status).toBe(400);
  });

  test('logout clears the session', async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const { cookie } = await login(app);
    const out = await request(app).post('/api/admin/logout').set('Cookie', cookie).set('X-Admin-Request', '1');
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie'][0]).toMatch(/Max-Age=0/);
  });

  test('the page is served at /admin and public routes are untouched', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    const page = await request(app).get('/admin');
    // 200 when the React app has been built, 404 with a hint otherwise — never a redirect or crash.
    expect([200, 404]).toContain(page.status);
    expect(page.headers['x-robots-tag']).toMatch(/noindex/);
  });

  test('overview lists a registered install without leaking tokens', async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const cfg = encodeConfigToken({ febboxTokens: ['super-secret-aaaa', 'super-secret-bbbb'], label: 'Living room' }, SECRET);
    await request(app).get(`/${cfg}/manifest.json`);
    const { cookie } = await login(app);

    const resp = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(resp.status).toBe(200);
    const inst = resp.body.installs.find((i) => i.label === 'Living room');
    expect(inst).toBeDefined();
    expect(inst.tokens).toHaveLength(2);
    const body = JSON.stringify(resp.body);
    expect(body).not.toContain('super-secret-aaaa');
    // The addon link is returned (admin-only) so the page can offer "Copy link".
    expect(inst.installPath).toBe(`/${cfg}/manifest.json`);
  });

  test('admin can swap tokens without changing the install URL; GET never returns them', async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const cfg = encodeConfigToken({ febboxTokens: ['original-token-1'], label: 'Swap me' }, SECRET);
    await request(app).get(`/${cfg}/manifest.json`);
    const id = registry.list().find((i) => i.label === 'Swap me').id;
    const { cookie } = await login(app);

    // FebBox accepts the new token.
    nock('https://www.febbox.com').get('/console/user_cards').query(true)
      .reply(200, { data: { flow: { traffic_limit_mb: 1000, traffic_usage_mb: 10 } } }).persist();

    const resp = await request(app).put(`/api/admin/installs/${id}/tokens`).set('Cookie', cookie).set('X-Admin-Request', '1')
      .send({ slots: [{ token: 'replacement-token-2' }, { keep: registry.list().find((i) => i.id === id).tokens[0].hash }] });
    expect(resp.status).toBe(200);
    expect(JSON.stringify(resp.body)).not.toContain('replacement-token-2');
    expect(registry.getOverrideTokens(id)).toEqual(['replacement-token-2', 'original-token-1']);

    const overview = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    const inst = overview.body.installs.find((i) => i.id === id);
    expect(inst.hasOverride).toBe(true);
    expect(inst.tokens).toHaveLength(2);
    expect(JSON.stringify(overview.body)).not.toContain('replacement-token-2');

    const reset = await request(app).delete(`/api/admin/installs/${id}/tokens`).set('Cookie', cookie).set('X-Admin-Request', '1');
    expect(reset.status).toBe(200);
    expect(registry.getOverrideTokens(id)).toBeNull();
    nock.cleanAll();
  });

  test('a token FebBox rejects is not saved', async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const cfg = encodeConfigToken({ febboxTokens: ['original-token-9'], label: 'Reject me' }, SECRET);
    await request(app).get(`/${cfg}/manifest.json`);
    const id = registry.list().find((i) => i.label === 'Reject me').id;
    const { cookie } = await login(app);
    nock('https://www.febbox.com').get('/console/user_cards').query(true).reply(401, {});

    const resp = await request(app).put(`/api/admin/installs/${id}/tokens`).set('Cookie', cookie).set('X-Admin-Request', '1')
      .send({ slots: [{ token: 'bad-bad-token-x' }] });
    expect(resp.status).toBe(400);
    expect(registry.getOverrideTokens(id)).toBeNull();
    nock.cleanAll();
  });

  test('mutating routes need the X-Admin-Request header; block stops streams', async () => {
    process.env.ADMIN_PASSWORD = PASSWORD;
    const cfg = encodeConfigToken({ febboxTokens: ['blockme-token-1'], label: 'Blocked one' }, SECRET);
    await request(app).get(`/${cfg}/manifest.json`);
    const id = registry.list().find((i) => i.label === 'Blocked one').id;
    const { cookie } = await login(app);

    const noHeader = await request(app).post(`/api/admin/installs/${id}/block`).set('Cookie', cookie).send({ blocked: true });
    expect(noHeader.status).toBe(400);

    const ok = await request(app).post(`/api/admin/installs/${id}/block`).set('Cookie', cookie).set('X-Admin-Request', '1').send({ blocked: true });
    expect(ok.status).toBe(200);

    const stream = await request(app).get(`/${cfg}/stream/movie/tt1375666.json`);
    expect(stream.body.streams).toEqual([]);
  });
});

describe('stream route with two tokens', () => {
  let app;
  beforeAll(() => {
    app = createApp();
  });
  afterEach(() => {
    nock.cleanAll();
    catalogCache.clear();
    playbackCache.clear();
    tokenPool.reset();
  });

  function mockDiscovery() {
    nock('https://api.themoviedb.org').get('/3/find/tt1375666').query(true)
      .reply(200, { movie_results: [{ id: 27205, title: 'Inception', release_date: '2010-07-16' }], tv_results: [] });
    nock('https://api.themoviedb.org').get('/3/movie/27205/alternative_titles').query(true).reply(200, { titles: [] });
    nock('https://www.showbox.media').get('/search').query({ keyword: 'Inception' })
      .reply(200, '<html><body><a href="/movie/m-inception-2010">Inception</a></body></html>');
    nock('https://www.showbox.media').get('/movie/m-inception-2010')
      .reply(200, `<script>$.ajax({url:'/index/share_link',data:{'id':4059,'type':1}})</script>`);
    nock('https://www.showbox.media').get('/index/share_link').query({ id: '4059', type: '1' })
      .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/Bp1Hw1MK' } });
    nock('https://www.febbox.com').get('/share/Bp1Hw1MK').reply(200, '<html>alive</html>');
  }

  test('uses the second token when the first has no quota left', async () => {
    mockDiscovery();
    // First token: quota exhausted. Second: plenty left.
    nock('https://www.febbox.com', { reqheaders: { cookie: 'ui=first-token-1234' } })
      .get('/console/user_cards').reply(200, { data: { flow: { traffic_limit_mb: 102400, traffic_usage_mb: 102400 } } });
    nock('https://www.febbox.com', { reqheaders: { cookie: 'ui=second-token-5678' } })
      .get('/console/user_cards').reply(200, { data: { flow: { traffic_limit_mb: 102400, traffic_usage_mb: 100 } } });
    // Only the second token may be used to list/resolve files.
    nock('https://www.febbox.com', { reqheaders: { cookie: 'ui=second-token-5678' } })
      .get('/file/file_share_list').query(true)
      .reply(200, { data: { file_list: [{ fid: 1, file_name: 'Inception.2010.mkv', is_dir: false }] } });
    nock('https://www.febbox.com', { reqheaders: { cookie: 'ui=second-token-5678' } })
      .get('/console/video_quality_list').query((q) => q.fid === '1')
      .reply(200, { html: '<div class="file_quality" data-url="https://usa7-a1.shegu.net/org.mp4" data-quality="ORG"><p class="size">3.6 GB</p></div>' });
    nock('https://usa7-a1.shegu.net').head('/org.mp4').reply(200, '', { 'content-type': 'video/mp4' });

    const cfg = encodeConfigToken({ febboxTokens: ['first-token-1234', 'second-token-5678'] }, SECRET);
    const resp = await request(app).get(`/${cfg}/stream/movie/tt1375666.json`);
    expect(resp.status).toBe(200);
    expect(resp.body.streams).toHaveLength(1);
    expect(resp.body.streams[0].url).toBe('https://usa7-a1.shegu.net/org.mp4');
  });
});
