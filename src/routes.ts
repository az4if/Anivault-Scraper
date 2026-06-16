import { Router, Request, Response } from 'express';
import axios from 'axios';
import { malToAnilist, getSiteIds, searchAnilist } from './utils/mapper';
import { cacheStats } from './utils/cache';
import { resolveEmbed } from './resolvers/megacloud';

import { getEpisodes, getServers, getEmbedUrl } from './scrapers/senshi';
import { getDaoEpisodes, getDaoServers, getDaoEmbedUrl } from './scrapers/anidao';
import { getWaveEpisodes, getWaveServers, getWaveEmbedUrl } from './scrapers/aniwaves';
import { getHeavenEpisodes, getHeavenServers, getHeavenStream } from './scrapers/animeheaven';
import { getMiruroEpisodes, getMiruroServers, getMiruroEmbedUrl } from './scrapers/miruro';

const router = Router();

const SOURCES = ['senshi', 'dao', 'wave', 'animeheaven', 'miruro'] as const;
type Source = typeof SOURCES[number];

function publicBase(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function proxiedHlsUrl(req: Request, url: string, ref?: string): string {
  const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  return `${publicBase(req)}/api/proxy/hls?url=${encodeURIComponent(url)}${refParam}`;
}

function proxiedVideoUrl(req: Request, url: string): string {
  return `${publicBase(req)}/api/proxy/video?url=${encodeURIComponent(url)}`;
}

function rewriteHlsPlaylist(req: Request, body: string, sourceUrl: string, ref?: string): string {
  const base = new URL(sourceUrl);
  return body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI=')) {
        return line.replace(/URI="([^"]+)"/, (_m, uri) => {
          const absolute = new URL(uri, base).toString();
          return `URI="${proxiedHlsUrl(req, absolute, ref)}"`;
        });
      }
      if (trimmed.startsWith('#')) return line;
      return proxiedHlsUrl(req, new URL(trimmed, base).toString(), ref);
    })
    .join('\n');
}

async function resolveAlId(anilistId?: string, malId?: string): Promise<number | null> {
  if (anilistId) return parseInt(anilistId);
  if (malId) return malToAnilist(parseInt(malId));
  return null;
}

async function fetchEpisodes(source: Source, siteIds: any, overrides: { heavenId?: string } = {}): Promise<{ episodes: any[]; siteId: string; error?: string }> {
  const zoroId = siteIds.siteIds?.zoro as string | undefined;
  const heavenId = overrides.heavenId || (siteIds.siteIds?.animeheaven as string | undefined);

  if (source === 'senshi') {
    if (!siteIds.malId) return { episodes: [], siteId: '', error: 'Missing MAL ID for Senshi' };
    const senshiId = String(siteIds.malId);
    return { episodes: await getEpisodes(senshiId), siteId: senshiId };
  }
  if (source === 'dao') {
    if (!zoroId) return { episodes: [], siteId: '', error: 'Not indexed on AniDao' };
    return { episodes: await getDaoEpisodes(zoroId), siteId: zoroId };
  }
  if (source === 'wave') {
    if (!zoroId) return { episodes: [], siteId: '', error: 'Not indexed on AniWaves' };
    return { episodes: await getWaveEpisodes(zoroId), siteId: zoroId };
  }
  if (source === 'animeheaven') {
    if (!heavenId) return { episodes: [], siteId: '', error: 'Not indexed on AnimeHeaven' };
    return { episodes: await getHeavenEpisodes(heavenId), siteId: heavenId };
  }
  if (source === 'miruro') {
    if (!siteIds.anilistId) return { episodes: [], siteId: '', error: 'Missing AniList ID for Miruro' };
    const alId = siteIds.anilistId as number;
    return { episodes: await getMiruroEpisodes(alId), siteId: String(alId) };
  }
  return { episodes: [], siteId: '', error: 'Unknown source' };
}

router.get('/search', async (req: Request, res: Response) => {
  const q = req.query.q as string;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const results = await searchAnilist(q);
    return res.json({ query: q, count: results.length, results });
  } catch (e) {
    return res.status(500).json({ error: 'Search failed', detail: String(e) });
  }
});

router.get('/info', async (req: Request, res: Response) => {
  const { anilistId, malId } = req.query;
  if (!anilistId && !malId) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=' });
  try {
    const alId = await resolveAlId(anilistId as string, malId as string);
    if (!alId) return res.status(404).json({ error: 'Anime not found on AniList' });
    const info = await getSiteIds(alId);
    if (!info) return res.status(404).json({ error: 'Could not fetch info' });
    return res.json(info);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

router.get('/episodes', async (req: Request, res: Response) => {
  const { anilistId, malId, source = 'senshi', heavenId } = req.query;
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
  try {
    if (source === 'animeheaven' && heavenId && !anilistId && !malId) {
      const episodes = await getHeavenEpisodes(String(heavenId));
      return res.json({ anilistId: null, malId: null, title: null, source, siteId: String(heavenId), count: episodes.length, episodes });
    }

    const alId = await resolveAlId(anilistId as string, malId as string);
    if (!alId) return res.status(404).json({ error: 'Anime not found' });
    const siteIds = await getSiteIds(alId);
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve site IDs' });
    const result = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
    if (result.error) return res.status(404).json({ error: result.error });
    return res.json({ anilistId: alId, malId: siteIds.malId, title: siteIds.title, source, siteId: result.siteId, count: result.episodes.length, episodes: result.episodes });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

router.get('/servers', async (req: Request, res: Response) => {
  const { anilistId, malId, ep, type = 'sub', source = 'senshi', heavenId } = req.query;
  if (!ep) return res.status(400).json({ error: 'Missing ?ep=' });
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  const epNum = parseInt(ep as string);
  if (isNaN(epNum)) return res.status(400).json({ error: '?ep must be a number' });
  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });

  try {
    const siteIds = heavenId && source === 'animeheaven'
      ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: String(heavenId) } }
      : await (async () => {
          const alId = await resolveAlId(anilistId as string, malId as string);
          if (!alId) return null;
          return getSiteIds(alId);
        })();
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve site IDs' });

    const epResult = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
    if (epResult.error) return res.status(404).json({ error: epResult.error });
    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return res.status(404).json({ error: `Episode ${epNum} not found` });

    let allServers: any[] = [];
    if (source === 'senshi') allServers = await getServers(episode.id);
    if (source === 'dao') allServers = await getDaoServers(episode.id);
    if (source === 'wave') allServers = await getWaveServers(episode.id);
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id);
    if (source === 'miruro') allServers = await getMiruroServers(episode.id);

    const filtered = type === 'all' ? allServers : allServers.filter((s: any) => s.type === type);
    return res.json({
      anilistId: siteIds.anilistId,
      malId: siteIds.malId,
      title: siteIds.title,
      episode: epNum,
      type,
      source,
      siteId: epResult.siteId,
      servers: filtered.map((s: any) => ({ name: s.name, sourceId: s.sourceId, type: s.type })),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

async function watchHandler(req: Request, res: Response) {
  const { source, id, ep, type } = req.params;
  const preferredServer = req.query.server as string | undefined;
  const heavenOverride = req.query.heavenId as string | undefined;

  if (!SOURCES.includes(source as Source)) return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
  const epNum = parseInt(ep);
  if (isNaN(epNum)) return res.status(400).json({ error: 'ep must be a number' });
  if (!['sub', 'dub', 'raw'].includes(type)) return res.status(400).json({ error: 'type must be: sub, dub, raw' });

  const directHeavenId = source === 'animeheaven' && !id.startsWith('mal-') && !/^\d+$/.test(id);
  const anilistId = directHeavenId || id.startsWith('mal-') ? undefined : id;
  const malId = id.startsWith('mal-') ? id.replace('mal-', '') : undefined;

  try {
    const siteIds = directHeavenId
      ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: id } }
      : await (async () => {
          const alId = await resolveAlId(anilistId, malId);
          if (!alId) return null;
          return getSiteIds(alId);
        })();
    if (!siteIds) return res.status(404).json({ error: 'Could not resolve anime' });

    const epResult = await fetchEpisodes(source as Source, siteIds, { heavenId: heavenOverride });
    if (epResult.error) return res.status(404).json({ error: epResult.error });

    const episode = epResult.episodes.find((e: any) => Math.round(e.num) === epNum);
    if (!episode) return res.status(404).json({ error: `Episode ${epNum} not found` });

    let allServers: any[] = [];
    if (source === 'senshi') allServers = await getServers(episode.id);
    if (source === 'dao') allServers = await getDaoServers(episode.id);
    if (source === 'wave') allServers = await getWaveServers(episode.id);
    if (source === 'animeheaven') allServers = await getHeavenServers(episode.id);
    if (source === 'miruro') allServers = await getMiruroServers(episode.id);

    let filtered = allServers.filter((s: any) => s.type === type);
    if (!filtered.length) filtered = allServers.filter((s: any) => s.type === 'sub');
    if (!filtered.length) return res.status(404).json({ error: `No servers found for ep ${epNum}` });

    if (preferredServer) {
      filtered.sort((a: any, b: any) => {
        const aM = a.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
        const bM = b.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
        return aM - bM;
      });
    }

    let embedResult: any = null;
    let usedServer = '';
    for (const server of filtered) {
      let raw: any = null;
      if (source === 'senshi') raw = await getEmbedUrl(server.sourceId);
      if (source === 'dao') raw = await getDaoEmbedUrl(server.sourceId);
      if (source === 'wave') raw = await getWaveEmbedUrl(server.sourceId);
      if (source === 'animeheaven') raw = await getHeavenStream(server.sourceId);
      if (source === 'miruro') raw = await getMiruroEmbedUrl(server.sourceId);
      if (raw) { embedResult = raw; usedServer = server.name; break; }
    }
    if (!embedResult) return res.status(502).json({ error: 'All servers failed' });

    if (source === 'animeheaven') {
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        siteId: epResult.siteId,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: embedResult.embedUrl,
        streamUrl: proxiedVideoUrl(req, embedResult.streamUrl),
        rawStreamUrl: embedResult.streamUrl,
        mp4: embedResult.mp4,
        mp4ProxyUrl: proxiedVideoUrl(req, embedResult.mp4),
        m3u8: null,
        hlsProxyUrl: null,
        playbackMode: 'mp4',
        iframeOnly: false,
        subtitles: [],
        note: 'AnimeHeaven currently exposes direct MP4 sources, not m3u8/HLS.',
      });
    }

    // Miruro streams are always direct HLS — skip megacloud resolver entirely.
    // The embedUrl IS the m3u8 regardless of whether the path contains ".m3u8",
    // since CDN providers (moo, bonk, bee, etc.) use extension-less signed URLs.
    if (source === 'miruro') {
      const m3u8Url = embedResult.embedUrl as string;
      return res.json({
        anilistId: siteIds.anilistId,
        malId: siteIds.malId,
        title: siteIds.title,
        episode: epNum,
        type,
        source,
        server: usedServer,
        availableServers: filtered.map((s: any) => s.name),
        embedUrl: m3u8Url,
        m3u8: m3u8Url,
        hlsProxyUrl: proxiedHlsUrl(req, m3u8Url, embedResult.referer ?? 'https://www.miruro.tv/'),
        playbackMode: 'hls',
        iframeOnly: false,
        subtitles: [],
        intro: null,
        outro: null,
        note: null,
      });
    }

    const directM3u8 = typeof embedResult.embedUrl === 'string' && embedResult.embedUrl.includes('.m3u8');
    const stream = directM3u8 ? null : await resolveEmbed(embedResult.embedUrl);
    const hasHls = Boolean(directM3u8 || stream?.m3u8);
    return res.json({
      anilistId: siteIds.anilistId,
      malId: siteIds.malId,
      title: siteIds.title,
      episode: epNum,
      type,
      source,
      server: usedServer,
      availableServers: filtered.map((s: any) => s.name),
      embedUrl: embedResult.embedUrl,
      m3u8: directM3u8 ? embedResult.embedUrl : stream?.m3u8 ?? null,
      hlsProxyUrl: directM3u8 ? proxiedHlsUrl(req, embedResult.embedUrl, embedResult.referer) : (stream?.m3u8 ? proxiedHlsUrl(req, stream.m3u8, embedResult.referer) : null),
      playbackMode: hasHls ? 'hls' : 'iframe',
      iframeOnly: !hasHls,
      subtitles: stream?.subtitles ?? [],
      intro: stream?.intro ?? null,
      outro: stream?.outro ?? null,
      note: directM3u8 || stream ? null : 'Use embedUrl in iframe - m3u8 decrypt failed (key may have rotated)',
    });
  } catch (e) {
    console.error(`[/watch/${source}]`, e);
    return res.status(500).json({ error: 'Stream fetch failed', detail: String(e) });
  }
}

router.get('/watch/:source/:id/:ep/:type', watchHandler);

router.get('/proxy/hls', async (req: Request, res: Response) => {
  const url = req.query.url as string | undefined;
  const ref = req.query.ref as string | undefined;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: '?url must be absolute http(s)' });

  let referer = 'https://senshi.live/';
  let origin = 'https://senshi.live';
  if (ref && /^https?:\/\//i.test(ref)) {
    referer = ref;
    try {
      origin = new URL(ref).origin;
    } catch {
      // keep default origin if ref is malformed
    }
  }

  try {
    const upstream = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': referer,
        'Origin': origin,
      },
    });

    const contentType = String(upstream.headers['content-type'] ?? '');
    const body = Buffer.from(upstream.data);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=30');

    if (url.includes('.m3u8') || contentType.includes('mpegurl')) {
      const text = body.toString('utf8');
      if (!text.trim().startsWith('#EXTM3U')) {
        return res.status(502).json({ error: 'Upstream did not return a valid m3u8 playlist', body: text.slice(0, 300) });
      }
      res.type('application/vnd.apple.mpegurl');
      return res.send(rewriteHlsPlaylist(req, text, url, ref));
    }

    res.type(contentType || 'application/octet-stream');
    return res.send(body);
  } catch (e: any) {
    return res.status(e?.response?.status || 502).json({ error: 'HLS proxy failed', detail: e?.message || String(e) });
  }
});

router.get('/proxy/video', async (req: Request, res: Response) => {
  const url = req.query.url as string | undefined;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: '?url must be absolute http(s)' });

  try {
    const upstream = await axios.get(url, {
      responseType: 'stream',
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Referer': 'https://animeheaven.me/',
        'Origin': 'https://animeheaven.me',
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      validateStatus: (status) => (status >= 200 && status < 300) || status === 206,
    });

    res.status(upstream.status);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const acceptRanges = upstream.headers['accept-ranges'];
    const cacheControl = upstream.headers['cache-control'];
    res.setHeader('Accept-Ranges', typeof acceptRanges === 'string' ? acceptRanges : 'bytes');
    res.setHeader('Cache-Control', typeof cacheControl === 'string' ? cacheControl : 'public, max-age=3600');

    for (const header of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
      const value = upstream.headers[header];
      if (typeof value === 'string' || typeof value === 'number' || Array.isArray(value)) {
        res.setHeader(header, value);
      }
    }

    return upstream.data.pipe(res);
  } catch (e: any) {
    return res.status(e?.response?.status || 502).json({ error: 'Video proxy failed', detail: e?.message || String(e) });
  }
});

router.get('/watch', async (req: Request, res: Response) => {
  const { anilistId, malId, heavenId, ep, type = 'sub', source = 'senshi', server } = req.query;
  if (!ep) return res.status(400).json({ error: 'Missing ?ep=' });
  if (!anilistId && !malId && !(source === 'animeheaven' && heavenId)) return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
  const id = heavenId && source === 'animeheaven' ? String(heavenId) : anilistId ? String(anilistId) : `mal-${malId}`;
  req.params.source = String(source);
  req.params.id = id;
  req.params.ep = String(ep);
  req.params.type = String(type);
  if (server) req.query.server = server;
  return watchHandler(req, res);
});

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.1-miruro-debug', sources: SOURCES, uptime: Math.floor(process.uptime()), cache: cacheStats(), timestamp: new Date().toISOString() });
});

export default router;
