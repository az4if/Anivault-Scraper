import axios, { AxiosInstance } from 'axios';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// FlareSolverr endpoint — set FLARESOLVERR_URL in your Railway environment variables.
// Deploy FlareSolverr as a separate Railway service:
//   Docker image: ghcr.io/flaresolverr/flaresolverr:latest
//   Expose port 8191
// Then set FLARESOLVERR_URL=http://<your-flaresolverr-service>:8191
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || '';

// Cache the CF clearance cookie+UA per domain so we don't call FlareSolverr on every request
const cfCache = new Map<string, { cookies: string; userAgent: string; expiresAt: number }>();

async function getCfClearance(url: string): Promise<{ cookies: string; userAgent: string } | null> {
  if (!FLARESOLVERR_URL) return null;

  const domain = new URL(url).hostname;
  const cached = cfCache.get(domain);
  if (cached && cached.expiresAt > Date.now()) {
    return { cookies: cached.cookies, userAgent: cached.userAgent };
  }

  try {
    const res = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'request.get',
      url,
      maxTimeout: 60000,
    }, { timeout: 70000 });

    const solution = res.data?.solution;
    if (!solution) return null;

    const cookies = (solution.cookies as any[])
      .map((c: any) => `${c.name}=${c.value}`)
      .join('; ');

    const result = { cookies, userAgent: solution.userAgent as string };
    // Cache for 25 minutes (CF clearance cookies last ~30min)
    cfCache.set(domain, { ...result, expiresAt: Date.now() + 25 * 60 * 1000 });
    return result;
  } catch (e) {
    console.error('[FlareSolverr] failed:', (e as Error).message);
    return null;
  }
}

// Creates an axios instance that automatically injects CF clearance cookies
// when FLARESOLVERR_URL is set, falling back to plain requests otherwise.
export function makeClient(baseURL: string, referer: string, extra?: Record<string, string>): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 15000,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': referer,
      'Origin': new URL(referer).origin,
      'X-Requested-With': 'XMLHttpRequest',
      ...extra,
    },
  });

  // Inject CF clearance before every request
  instance.interceptors.request.use(async (config) => {
    const fullUrl = (config.baseURL || '') + (config.url || '');
    const cf = await getCfClearance(fullUrl);
    if (cf) {
      config.headers['Cookie'] = cf.cookies;
      config.headers['User-Agent'] = cf.userAgent;
    }
    return config;
  });

  return instance;
}

export function makeAjaxClient(baseURL: string, referer: string, extra?: Record<string, string>): AxiosInstance {
  return makeClient(baseURL, referer, {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    ...extra,
  });
}

export const anilistClient = axios.create({
  baseURL: 'https://graphql.anilist.co',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});
