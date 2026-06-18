"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const axios_1 = __importDefault(require("axios"));
const mapper_1 = require("./utils/mapper");
const cache_1 = require("./utils/cache");
const megacloud_1 = require("./resolvers/megacloud");
const senshi_1 = require("./scrapers/senshi");
const anidao_1 = require("./scrapers/anidao");
const aniwaves_1 = require("./scrapers/aniwaves");
const animeheaven_1 = require("./scrapers/animeheaven");
const miruro_1 = require("./scrapers/miruro");
const router = (0, express_1.Router)();
const SOURCES = ['senshi', 'dao', 'wave', 'animeheaven', 'miruro'];
function publicBase(req) {
    const proto = req.headers['x-forwarded-proto']?.split(',')[0] || req.protocol;
    return `${proto}://${req.get('host')}`;
}
function proxiedHlsUrl(req, url, ref) {
    const refParam = ref ? `&ref=${encodeURIComponent(ref)}` : '';
    return `${publicBase(req)}/api/proxy/hls?url=${encodeURIComponent(url)}${refParam}`;
}
function proxiedVideoUrl(req, url) {
    return `${publicBase(req)}/api/proxy/video?url=${encodeURIComponent(url)}`;
}
function rewriteHlsPlaylist(req, body, sourceUrl, ref) {
    const base = new URL(sourceUrl);
    return body
        .split(/\r?\n/)
        .map((line) => {
        const trimmed = line.trim();
        if (!trimmed)
            return line;
        if (trimmed.startsWith('#EXT-X-KEY') && trimmed.includes('URI=')) {
            return line.replace(/URI="([^"]+)"/, (_m, uri) => {
                const absolute = new URL(uri, base).toString();
                return `URI="${proxiedHlsUrl(req, absolute, ref)}"`;
            });
        }
        if (trimmed.startsWith('#'))
            return line;
        return proxiedHlsUrl(req, new URL(trimmed, base).toString(), ref);
    })
        .join('\n');
}
async function resolveAlId(anilistId, malId) {
    if (anilistId)
        return parseInt(anilistId);
    if (malId)
        return (0, mapper_1.malToAnilist)(parseInt(malId));
    return null;
}
async function fetchEpisodes(source, siteIds, overrides = {}) {
    const zoroId = siteIds.siteIds?.zoro;
    const heavenId = overrides.heavenId || siteIds.siteIds?.animeheaven;
    if (source === 'senshi') {
        if (!siteIds.malId)
            return { episodes: [], siteId: '', error: 'Missing MAL ID for Senshi' };
        const senshiId = String(siteIds.malId);
        return { episodes: await (0, senshi_1.getEpisodes)(senshiId), siteId: senshiId };
    }
    if (source === 'dao') {
        if (!zoroId)
            return { episodes: [], siteId: '', error: 'Not indexed on AniDao' };
        return { episodes: await (0, anidao_1.getDaoEpisodes)(zoroId), siteId: zoroId };
    }
    if (source === 'wave') {
        if (!zoroId)
            return { episodes: [], siteId: '', error: 'Not indexed on AniWaves' };
        return { episodes: await (0, aniwaves_1.getWaveEpisodes)(zoroId), siteId: zoroId };
    }
    if (source === 'animeheaven') {
        if (!heavenId)
            return { episodes: [], siteId: '', error: 'Not indexed on AnimeHeaven' };
        return { episodes: await (0, animeheaven_1.getHeavenEpisodes)(heavenId), siteId: heavenId };
    }
    if (source === 'miruro') {
        if (!siteIds.anilistId)
            return { episodes: [], siteId: '', error: 'Missing AniList ID for Miruro' };
        const alId = siteIds.anilistId;
        return { episodes: await (0, miruro_1.getMiruroEpisodes)(alId), siteId: String(alId) };
    }
    return { episodes: [], siteId: '', error: 'Unknown source' };
}
router.get('/search', async (req, res) => {
    const q = req.query.q;
    if (!q)
        return res.status(400).json({ error: 'Missing ?q=' });
    try {
        const results = await (0, mapper_1.searchAnilist)(q);
        return res.json({ query: q, count: results.length, results });
    }
    catch (e) {
        return res.status(500).json({ error: 'Search failed', detail: String(e) });
    }
});
router.get('/info', async (req, res) => {
    const { anilistId, malId } = req.query;
    if (!anilistId && !malId)
        return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=' });
    try {
        const alId = await resolveAlId(anilistId, malId);
        if (!alId)
            return res.status(404).json({ error: 'Anime not found on AniList' });
        const info = await (0, mapper_1.getSiteIds)(alId);
        if (!info)
            return res.status(404).json({ error: 'Could not fetch info' });
        return res.json(info);
    }
    catch (e) {
        return res.status(500).json({ error: String(e) });
    }
});
router.get('/episodes', async (req, res) => {
    const { anilistId, malId, source = 'senshi', heavenId } = req.query;
    if (!anilistId && !malId && !(source === 'animeheaven' && heavenId))
        return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
    if (!SOURCES.includes(source))
        return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
    try {
        if (source === 'animeheaven' && heavenId && !anilistId && !malId) {
            const episodes = await (0, animeheaven_1.getHeavenEpisodes)(String(heavenId));
            return res.json({ anilistId: null, malId: null, title: null, source, siteId: String(heavenId), count: episodes.length, episodes });
        }
        const alId = await resolveAlId(anilistId, malId);
        if (!alId)
            return res.status(404).json({ error: 'Anime not found' });
        const siteIds = await (0, mapper_1.getSiteIds)(alId);
        if (!siteIds)
            return res.status(404).json({ error: 'Could not resolve site IDs' });
        const result = await fetchEpisodes(source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
        if (result.error)
            return res.status(404).json({ error: result.error });
        return res.json({ anilistId: alId, malId: siteIds.malId, title: siteIds.title, source, siteId: result.siteId, count: result.episodes.length, episodes: result.episodes });
    }
    catch (e) {
        return res.status(500).json({ error: String(e) });
    }
});
router.get('/servers', async (req, res) => {
    const { anilistId, malId, ep, type = 'sub', source = 'senshi', heavenId } = req.query;
    if (!ep)
        return res.status(400).json({ error: 'Missing ?ep=' });
    if (!anilistId && !malId && !(source === 'animeheaven' && heavenId))
        return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
    const epNum = parseInt(ep);
    if (isNaN(epNum))
        return res.status(400).json({ error: '?ep must be a number' });
    if (!SOURCES.includes(source))
        return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
    try {
        const siteIds = heavenId && source === 'animeheaven'
            ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: String(heavenId) } }
            : await (async () => {
                const alId = await resolveAlId(anilistId, malId);
                if (!alId)
                    return null;
                return (0, mapper_1.getSiteIds)(alId);
            })();
        if (!siteIds)
            return res.status(404).json({ error: 'Could not resolve site IDs' });
        const epResult = await fetchEpisodes(source, siteIds, { heavenId: heavenId ? String(heavenId) : undefined });
        if (epResult.error)
            return res.status(404).json({ error: epResult.error });
        const episode = epResult.episodes.find((e) => Math.round(e.num) === epNum);
        if (!episode)
            return res.status(404).json({ error: `Episode ${epNum} not found` });
        let allServers = [];
        if (source === 'senshi')
            allServers = await (0, senshi_1.getServers)(episode.id);
        if (source === 'dao')
            allServers = await (0, anidao_1.getDaoServers)(episode.id);
        if (source === 'wave')
            allServers = await (0, aniwaves_1.getWaveServers)(episode.id);
        if (source === 'animeheaven')
            allServers = await (0, animeheaven_1.getHeavenServers)(episode.id);
        if (source === 'miruro')
            allServers = await (0, miruro_1.getMiruroServers)(episode.id);
        const filtered = type === 'all' ? allServers : allServers.filter((s) => s.type === type);
        return res.json({
            anilistId: siteIds.anilistId,
            malId: siteIds.malId,
            title: siteIds.title,
            episode: epNum,
            type,
            source,
            siteId: epResult.siteId,
            servers: filtered.map((s) => ({ name: s.name, sourceId: s.sourceId, type: s.type })),
        });
    }
    catch (e) {
        return res.status(500).json({ error: String(e) });
    }
});
async function watchHandler(req, res) {
    const { source, id, ep, type } = req.params;
    const preferredServer = req.query.server;
    const heavenOverride = req.query.heavenId;
    if (!SOURCES.includes(source))
        return res.status(400).json({ error: `source must be: ${SOURCES.join(', ')}` });
    const epNum = parseInt(ep);
    if (isNaN(epNum))
        return res.status(400).json({ error: 'ep must be a number' });
    if (!['sub', 'dub', 'raw'].includes(type))
        return res.status(400).json({ error: 'type must be: sub, dub, raw' });
    const directHeavenId = source === 'animeheaven' && !id.startsWith('mal-') && !/^\d+$/.test(id);
    const anilistId = directHeavenId || id.startsWith('mal-') ? undefined : id;
    const malId = id.startsWith('mal-') ? id.replace('mal-', '') : undefined;
    try {
        const siteIds = directHeavenId
            ? { anilistId: null, malId: null, title: null, siteIds: { animeheaven: id } }
            : await (async () => {
                const alId = await resolveAlId(anilistId, malId);
                if (!alId)
                    return null;
                return (0, mapper_1.getSiteIds)(alId);
            })();
        if (!siteIds)
            return res.status(404).json({ error: 'Could not resolve anime' });
        const epResult = await fetchEpisodes(source, siteIds, { heavenId: heavenOverride });
        if (epResult.error)
            return res.status(404).json({ error: epResult.error });
        const episode = epResult.episodes.find((e) => Math.round(e.num) === epNum);
        if (!episode)
            return res.status(404).json({ error: `Episode ${epNum} not found` });
        let allServers = [];
        if (source === 'senshi')
            allServers = await (0, senshi_1.getServers)(episode.id);
        if (source === 'dao')
            allServers = await (0, anidao_1.getDaoServers)(episode.id);
        if (source === 'wave')
            allServers = await (0, aniwaves_1.getWaveServers)(episode.id);
        if (source === 'animeheaven')
            allServers = await (0, animeheaven_1.getHeavenServers)(episode.id);
        if (source === 'miruro')
            allServers = await (0, miruro_1.getMiruroServers)(episode.id);
        const filtered = allServers.filter((s) => s.type === type);
        if (!filtered.length)
            return res.status(404).json({ error: `No ${type} stream available on ${source} for ep ${epNum}` });
        if (preferredServer) {
            filtered.sort((a, b) => {
                const aM = a.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
                const bM = b.name.toLowerCase().includes(preferredServer.toLowerCase()) ? -1 : 1;
                return aM - bM;
            });
        }
        let embedResult = null;
        let usedServer = '';
        for (const server of filtered) {
            let raw = null;
            if (source === 'senshi')
                raw = await (0, senshi_1.getEmbedUrl)(server.sourceId);
            if (source === 'dao')
                raw = await (0, anidao_1.getDaoEmbedUrl)(server.sourceId);
            if (source === 'wave')
                raw = await (0, aniwaves_1.getWaveEmbedUrl)(server.sourceId);
            if (source === 'animeheaven')
                raw = await (0, animeheaven_1.getHeavenStream)(server.sourceId);
            if (source === 'miruro')
                raw = await (0, miruro_1.getMiruroEmbedUrl)(server.sourceId);
            if (raw) {
                embedResult = raw;
                usedServer = server.name;
                break;
            }
        }
        if (!embedResult)
            return res.status(502).json({ error: 'All servers failed' });
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
                availableServers: filtered.map((s) => s.name),
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
        // Miruro streams are usually direct HLS — the embedUrl IS the m3u8
        // regardless of whether the path contains ".m3u8". But some providers
        // mix embed-page links into the streams list with no hls entry at
        // all; getMiruroEmbedUrl reports which kind it picked via
        // embedResult.type, so branch on that instead of assuming.
        if (source === 'miruro') {
            const isHls = embedResult.type === 'hls';
            const url = embedResult.embedUrl;
            return res.json({
                anilistId: siteIds.anilistId,
                malId: siteIds.malId,
                title: siteIds.title,
                episode: epNum,
                type,
                source,
                server: usedServer,
                availableServers: filtered.map((s) => s.name),
                embedUrl: url,
                m3u8: isHls ? url : null,
                hlsProxyUrl: isHls ? proxiedHlsUrl(req, url, embedResult.referer) : null,
                playbackMode: isHls ? 'hls' : 'iframe',
                iframeOnly: !isHls,
                subtitles: [],
                intro: null,
                outro: null,
                note: isHls ? null : 'This provider returned no HLS stream for this episode/category — use embedUrl in an iframe.',
            });
        }
        const directM3u8 = typeof embedResult.embedUrl === 'string' && embedResult.embedUrl.includes('.m3u8');
        const stream = directM3u8 ? null : await (0, megacloud_1.resolveEmbed)(embedResult.embedUrl);
        const hasHls = Boolean(directM3u8 || stream?.m3u8);
        return res.json({
            anilistId: siteIds.anilistId,
            malId: siteIds.malId,
            title: siteIds.title,
            episode: epNum,
            type,
            source,
            server: usedServer,
            availableServers: filtered.map((s) => s.name),
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
    }
    catch (e) {
        console.error(`[/watch/${source}]`, e);
        return res.status(500).json({ error: 'Stream fetch failed', detail: String(e) });
    }
}
router.get('/watch/:source/:id/:ep/:type', watchHandler);
router.get('/proxy/hls', async (req, res) => {
    const url = req.query.url;
    const ref = req.query.ref;
    if (!url)
        return res.status(400).json({ error: 'Missing ?url=' });
    if (!/^https?:\/\//i.test(url))
        return res.status(400).json({ error: '?url must be absolute http(s)' });
    let referer;
    let origin;
    if (ref && /^https?:\/\//i.test(ref)) {
        referer = ref;
        try {
            origin = new URL(ref).origin;
        }
        catch {
            origin = undefined;
        }
    }
    try {
        const upstream = await axios_1.default.get(url, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                ...(referer ? { Referer: referer } : {}),
                ...(origin ? { Origin: origin } : {}),
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
    }
    catch (e) {
        return res.status(e?.response?.status || 502).json({ error: 'HLS proxy failed', detail: e?.message || String(e) });
    }
});
router.get('/proxy/video', async (req, res) => {
    const url = req.query.url;
    if (!url)
        return res.status(400).json({ error: 'Missing ?url=' });
    if (!/^https?:\/\//i.test(url))
        return res.status(400).json({ error: '?url must be absolute http(s)' });
    try {
        const upstream = await axios_1.default.get(url, {
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
    }
    catch (e) {
        return res.status(e?.response?.status || 502).json({ error: 'Video proxy failed', detail: e?.message || String(e) });
    }
});
router.get('/watch', async (req, res) => {
    const { anilistId, malId, heavenId, ep, type = 'sub', source = 'senshi', server } = req.query;
    if (!ep)
        return res.status(400).json({ error: 'Missing ?ep=' });
    if (!anilistId && !malId && !(source === 'animeheaven' && heavenId))
        return res.status(400).json({ error: 'Provide ?anilistId= or ?malId=, or ?heavenId= for AnimeHeaven' });
    const id = heavenId && source === 'animeheaven' ? String(heavenId) : anilistId ? String(anilistId) : `mal-${malId}`;
    req.params.source = String(source);
    req.params.id = id;
    req.params.ep = String(ep);
    req.params.type = String(type);
    if (server)
        req.query.server = server;
    return watchHandler(req, res);
});
// ── DEBUG: dump raw miruro pipe sources (remove before production) ──────────
router.get('/debug/miruro-sources', async (req, res) => {
    const { anilistId, provider, category, episodeId } = req.query;
    if (!anilistId || !provider || !category || !episodeId) {
        return res.status(400).json({ error: 'Required: anilistId, provider, category, episodeId' });
    }
    try {
        const { getMiruroEmbedUrl } = await Promise.resolve().then(() => __importStar(require('./scrapers/miruro')));
        // sourceId format: anilistId::provider::category::episodeId
        const sourceId = `${anilistId}::${provider}::${category}::${episodeId}`;
        // Call fetchSources directly by re-implementing inline here for debug visibility
        const axios2 = (await Promise.resolve().then(() => __importStar(require('axios')))).default;
        const { Buffer: Buf } = await Promise.resolve().then(() => __importStar(require('buffer')));
        const zlib2 = await Promise.resolve().then(() => __importStar(require('zlib')));
        const PIPE_URL = 'https://www.miruro.tv/api/secure/pipe';
        const H = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            'Referer': 'https://www.miruro.tv/',
            'Origin': 'https://www.miruro.tv',
        };
        const encId = Buf.from(episodeId).toString('base64url');
        const payload = { path: 'sources', method: 'GET', query: { episodeId: encId, provider, category, anilistId: parseInt(anilistId) }, body: null, version: '0.1.0' };
        const encodedReq = Buf.from(JSON.stringify(payload)).toString('base64url');
        const r = await axios2.get(`${PIPE_URL}?e=${encodedReq}`, { headers: H, timeout: 15000, responseType: 'text', transformResponse: (d) => d });
        const padded = r.data + '='.repeat((4 - (r.data.length % 4)) % 4);
        const raw = JSON.parse(zlib2.gunzipSync(Buf.from(padded, 'base64url')).toString('utf-8'));
        return res.json({ sourceId, raw });
    }
    catch (e) {
        return res.status(500).json({ error: String(e?.message || e), stack: String(e?.stack || '') });
    }
});
// ── DEBUG: inspect raw miruro pipe sources for a provider ──────────────────
// GET /api/debug/miruro?anilistId=21&provider=bonk&ep=1&category=sub
router.get('/debug/miruro', async (req, res) => {
    try {
        const anilistId = parseInt(req.query.anilistId);
        const provider = req.query.provider || 'bonk';
        const epNum = parseInt(req.query.ep || '1');
        const category = (req.query.category || 'sub');
        if (isNaN(anilistId))
            return res.status(400).json({ error: 'anilistId required' });
        const servers = await (0, miruro_1.getMiruroServers)(`${anilistId}:${epNum}`);
        const match = servers.find(s => s.name === `${provider}-${category}`);
        if (!match)
            return res.json({ error: 'server not found', available: servers.map(s => s.name) });
        // Pull the raw episode ID out of the sourceId
        const parts = match.sourceId.split('::');
        const rawEpisodeId = parts.slice(3).join('::');
        // Re-encode and call the pipe directly (same as fetchSources does internally)
        const { Buffer } = await Promise.resolve().then(() => __importStar(require('buffer')));
        const zlib = await Promise.resolve().then(() => __importStar(require('zlib')));
        const encId = Buffer.from(rawEpisodeId).toString('base64url');
        const payload = { path: 'sources', method: 'GET', query: { episodeId: encId, provider, category, anilistId }, body: null, version: '0.1.0' };
        const encodedReq = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const pipeRes = await axios_1.default.get(`https://www.miruro.tv/api/secure/pipe?e=${encodedReq}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                'Referer': 'https://www.miruro.tv/',
            },
            timeout: 15000,
            responseType: 'text',
            transformResponse: (d) => d,
        });
        const padded = pipeRes.data + '='.repeat((4 - (pipeRes.data.length % 4)) % 4);
        const compressed = Buffer.from(padded, 'base64url');
        const decompressed = zlib.gunzipSync(compressed);
        const raw = JSON.parse(decompressed.toString('utf-8'));
        return res.json({
            sourceId: match.sourceId,
            rawEpisodeId,
            pipeTopLevelKeys: Object.keys(raw),
            streams: raw.streams ?? null,
            headers: raw.headers ?? null,
            intro: raw.intro ?? null,
            raw,
        });
    }
    catch (e) {
        return res.status(500).json({ error: String(e?.message || e), stack: e?.stack });
    }
});
router.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '1.0.1-miruro-debug', sources: SOURCES, uptime: Math.floor(process.uptime()), cache: (0, cache_1.cacheStats)(), timestamp: new Date().toISOString() });
});
exports.default = router;
//# sourceMappingURL=routes.js.map