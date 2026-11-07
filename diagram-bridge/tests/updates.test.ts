import { expect, test } from 'bun:test';
import { createUpdateChecker } from '../updates';

const tags = (...names: string[]) => Response.json(names.map(name => ({ name })));

test('checks anonymous stable v tags numerically, ignoring prereleases and unrelated tags', async () => {
  let input: unknown;
  let options: RequestInit | undefined;
  const check = createUpdateChecker('0.9.0', { fetchTags: async (url, init) => {
    input = url; options = init;
    return tags('v0.9.1', 'v0.10.0', 'v9.0.0-rc.1', 'v01.0.0', 'v2.0.0+build', 'assets-v99.0.0', 'garbage');
  } });
  expect(await check()).toEqual({ status: 'available', currentVersion: '0.9.0', latestVersion: '0.10.0', url: 'https://github.com/kewalaka/github-copilot-drawio/tree/v0.10.0/drawio-canvas' });
  expect(input).toBe('https://api.github.com/repos/kewalaka/github-copilot-drawio/tags?per_page=100&page=1');
  expect(options?.credentials).toBe('omit');
  expect(options?.redirect).toBe('error');
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(options?.headers).has('Authorization')).toBe(false);
});

test('never offers equal or older versions, including an empty tag list', async () => {
  for (const names of [[], ['v0.1.0'], ['v0.0.9']]) {
    expect((await createUpdateChecker('0.1.0', { fetchTags: async () => tags(...names) })()).status).toBe('current');
  }
});

test('paginates rather than assuming the first tag is the latest version', async () => {
  let calls = 0;
  const check = createUpdateChecker('0.1.0', { fetchTags: async url => {
    calls++;
    if (calls === 1) return tags(...Array.from({ length: 100 }, (_, i) => `v0.1.${i}`));
    expect(String(url)).toEndWith('page=2');
    return tags('v0.10.0');
  } });
  expect((await check()).latestVersion).toBe('0.10.0');
  expect(calls).toBe(2);
});

test('caps pagination without claiming an incomplete check is current', async () => {
  let calls = 0;
  const check = createUpdateChecker('0.1.0', { fetchTags: async () => {
    calls++;
    return tags(...Array.from({ length: 100 }, (_, i) => `v0.1.${i}`));
  } });
  expect(await check()).toEqual({ status: 'unavailable', currentVersion: '0.1.0' });
  expect(calls).toBe(5);
});

test('private repo, rate limits, server errors, malformed data and network failures are nonfatal', async () => {
  for (const status of [403, 404, 429, 500]) {
    expect(await createUpdateChecker('0.1.0', { fetchTags: async () => new Response('private detail', { status }) })()).toEqual({ status: 'unavailable', currentVersion: '0.1.0' });
  }
  for (const data of [{ name: 'v2.0.0' }, [null], [{ name: 12 }]]) {
    expect((await createUpdateChecker('0.1.0', { fetchTags: async () => Response.json(data) })()).status).toBe('unavailable');
  }
  expect((await createUpdateChecker('0.1.0', { fetchTags: async () => { throw new Error('private network detail'); } })()).status).toBe('unavailable');
});

test('deduplicates concurrent requests, caches success for an hour and retries failures after five minutes', async () => {
  let time = 0;
  let calls = 0;
  let failing = false;
  const check = createUpdateChecker('0.1.0', { now: () => time, fetchTags: async () => {
    calls++;
    return failing ? new Response('', { status: 404 }) : tags('v0.2.0');
  } });
  await Promise.all([check(), check()]);
  expect(calls).toBe(1);
  time = 60 * 60_000 - 1;
  await check(); expect(calls).toBe(1);
  time++;
  failing = true;
  expect((await check()).status).toBe('unavailable');
  expect(calls).toBe(2);
  time += 5 * 60_000 - 1;
  await check(); expect(calls).toBe(2);
  time++;
  failing = false;
  expect((await check()).status).toBe('available');
  expect(calls).toBe(3);
});

test('unversioned development bridges do not make network requests', async () => {
  const check = createUpdateChecker('development', { fetchTags: async () => { throw new Error('must not fetch'); } });
  expect(await check()).toEqual({ status: 'unavailable', currentVersion: 'development' });
});
