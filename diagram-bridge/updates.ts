const repository = 'https://github.com/kewalaka/github-copilot-drawio';
const tagsEndpoint = 'https://api.github.com/repos/kewalaka/github-copilot-drawio/tags';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type UpdateStatus = {
  status: 'available' | 'current' | 'unavailable';
  currentVersion: string;
  latestVersion?: string;
  url?: string;
};

function compareVersions(a: string, b: string) {
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function createUpdateChecker(currentVersion: string, {
  fetchTags = fetch,
  now = Date.now,
} = {}) {
  let cached: UpdateStatus | undefined;
  let expires = 0;
  let pending: Promise<UpdateStatus> | undefined;
  async function discover(): Promise<UpdateStatus> {
    if (!stable.test(currentVersion)) return { status: 'unavailable', currentVersion };
    const signal = AbortSignal.timeout(5_000);
    let latestVersion: string | undefined;
    for (let page = 1; page <= 5; page++) {
      const response = await fetchTags(`${tagsEndpoint}?per_page=100&page=${page}`, {
        signal, redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!response.ok) throw new Error('Tag check unavailable');
      const tags = await response.json();
      if (!Array.isArray(tags) || tags.length > 100 || tags.some(tag => typeof tag?.name !== 'string')) throw new Error('Invalid tag response');
      for (const { name } of tags) {
        if (!name.startsWith('v') || !stable.test(name.slice(1))) continue;
        const version = name.slice(1);
        if (!latestVersion || compareVersions(version, latestVersion) > 0) latestVersion = version;
      }
      if (tags.length < 100) {
        return latestVersion && compareVersions(latestVersion, currentVersion) > 0
          ? { status: 'available', currentVersion, latestVersion, url: `${repository}/tree/v${latestVersion}/drawio-canvas` }
          : { status: 'current', currentVersion, ...(latestVersion ? { latestVersion } : {}) };
      }
    }
    throw new Error('Tag pagination limit reached');
  }
  return async function check(): Promise<UpdateStatus> {
    if (cached && now() < expires) return cached;
    if (!pending) {
      pending = discover().catch(() => ({ status: 'unavailable' as const, currentVersion })).then(result => {
        cached = result;
        expires = now() + (result.status === 'unavailable' ? 5 * 60_000 : 60 * 60_000);
        return result;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
}
