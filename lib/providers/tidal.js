import { qualityLabel } from '../flac.js';
import { searchCache, streamCache } from '../cache.js';

const PREFIX = 'td';
const API_BASE = String(process.env.TIDAL_UPSTREAM_BASE_URL || 'https://hifi-api-production-8a1e.up.railway.app').replace(/\/+$/, '');
const UA = { 'User-Agent': 'BitChord/v1.8.1', Accept: 'application/json' };

function normaliseQuality(raw) {
    const q = String(raw || 'LOSSLESS').toUpperCase();
    if (q === 'HIGH' || q.includes('HIGH')) return 'HIGH';
    if (q === 'LOW' || q.includes('LOW')) return 'LOW';
    return 'LOSSLESS';
}

async function fetchJson(path, timeoutMs = 10000) {
    if (!API_BASE) {
        return { error: 'TIDAL_UPSTREAM_BASE_URL is not configured. Set it to the base URL of your authorized HiFi API.' };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(`${API_BASE}${path}`, { headers: UA, signal: ac.signal });
        const payload = await res.json().catch(() => ({}));
        if (res.status === 202 && payload?.requestId) {
            return await pollPlayback(payload);
        }
        if (!res.ok) return { error: `HiFi API returned ${res.status}` };
        return payload;
    } catch (err) {
        return { error: String(err?.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

async function pollPlayback(initial) {
    const statusPath = initial.statusUrl || `/playback/requests/${encodeURIComponent(initial.requestId)}`;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 6000);
        try {
            const res = await fetch(`${API_BASE}${statusPath}`, { headers: UA, signal: ac.signal });
            const body = await res.json().catch(() => ({}));
            if (body?.status === 'completed') return body;
            if (body?.status === 'failed' || body?.status === 'cancelled' || (res.status >= 400 && res.status !== 202)) {
                return { error: body?.detail || 'TIDAL playback request failed' };
            }
        } catch (err) {
            return { error: String(err?.message || err) };
        } finally {
            clearTimeout(timer);
        }
    }
    return { error: 'TIDAL playback request timed out while waiting in the account queue' };
}

function itemsFrom(payload) {
    const data = payload?.data;
    const candidates = [
        data?.items,
        data?.tracks,
        payload?.items,
        payload?.tracks,
        Array.isArray(data) ? data : null,
    ];
    for (const rows of candidates) {
        if (Array.isArray(rows)) return rows;
    }
    return [];
}

function mapTrack(item) {
    const rawId = String(item?.id || item?.trackId || '').replace(/^tidal:/i, '');
    if (!/^\d+$/.test(rawId) || !item?.title) return null;

    const artist = Array.isArray(item.artists) && item.artists.length
        ? item.artists.map((entry) => entry?.name).filter(Boolean).join(', ')
        : (typeof item.artist === 'string' ? item.artist : item.artist?.name || '');
    const album = typeof item.album === 'string' ? item.album : item.album?.title || '';
    const cover = item.album?.cover || item.cover;
    const artworkURL = /^https?:\/\//i.test(String(cover || ''))
        ? cover
        : (cover ? `https://resources.tidal.com/images/${String(cover).replace(/-/g, '/')}/320x320.jpg` : undefined);
    const duration = Number(item.duration) || undefined;
    const hires = String(item.audioQuality || '').includes('HI_RES')
        || item.mediaMetadata?.tags?.includes?.('HIRES_LOSSLESS') === true;

    return {
        id: `${PREFIX}:${rawId}`,
        title: item.title,
        artist,
        album,
        ...(duration ? { duration } : {}),
        ...(artworkURL ? { artworkURL } : {}),
        format: 'flac',
        audioQuality: hires ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
        source: 'Tidal',
        _hiRes: hires,
    };
}

export async function search(query, quality) {
    const q = String(query || '').trim();
    if (!q) return { tracks: [], error: null };

    return searchCache.wrap(`td:${normaliseQuality(quality)}:${q.toLowerCase()}`, async () => {
        const payload = await fetchJson(`/search/?s=${encodeURIComponent(q)}&limit=25`);
        const tracks = [];
        const seen = new Set();
        for (const item of itemsFrom(payload)) {
            const row = mapTrack(item);
            if (!row || seen.has(row.id)) continue;
            seen.add(row.id);
            tracks.push(row);
            if (tracks.length >= 25) break;
        }
        return { tracks, error: tracks.length ? null : (payload?.error || 'no TIDAL tracks returned by HiFi API') };
    });
}

function decodeUnencryptedFlac(payload) {
    const data = payload?.data || payload;
    if (!data || data.error || data.assetPresentation === 'PREVIEW') return null;
    if (typeof data.duration === 'number' && data.duration > 0 && data.duration <= 30) return null;
    if (typeof data.manifest !== 'string' || !data.manifest) return null;

    let manifest;
    try {
        const decoded = Buffer.from(data.manifest, 'base64').toString('utf8').trim();
        // BitChord's current stream contract accepts direct media URLs, not DASH manifests.
        if (!decoded.startsWith('{')) return null;
        manifest = JSON.parse(decoded);
    } catch {
        return null;
    }

    // Only use a server-declared unencrypted FLAC rendition. Never request or proxy DRM licenses.
    if (String(manifest.encryptionType || '').toUpperCase() !== 'NONE') return null;
    const mimeType = String(manifest.mimeType || data.manifestMimeType || '').toLowerCase();
    const codec = String(manifest.codecs || manifest.codec || '').toLowerCase();
    if (!mimeType.includes('flac') && !mimeType.includes('audio/flac')) return null;
    if (codec && !codec.includes('flac')) return null;

    const url = Array.isArray(manifest.urls) ? manifest.urls[0] : manifest.url;
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return null;

    const sampleRate = Number(data.sampleRate || manifest.sampleRate) || 0;
    const bitDepth = Number(data.bitDepth || manifest.bitDepth) || 0;
    if (!sampleRate || !bitDepth || sampleRate < 44100 || ![16, 24].includes(bitDepth)) return null;

    return {
        url,
        codec: 'flac',
        container: 'flac',
        manifest: 'none',
        mimeType: 'audio/flac',
        encrypted: false,
        sampleRate,
        bitDepth,
        format: 'flac',
        quality: qualityLabel({ codec: 'flac', sampleRate, bitDepth }),
        provider: 'Tidal',
    };
}

// Prefer authorized Hi-Res when the upstream exposes a direct, unencrypted FLAC URL.
// If it returns DASH or a protected manifest, decodeUnencryptedFlac rejects it and we retry CD FLAC.
function qualityAttempts(tier) {
    if (tier === 'LOSSLESS') return ['HI_RES_LOSSLESS', 'LOSSLESS'];
    if (tier === 'HIGH') return ['HIGH', 'LOSSLESS'];
    return [];
}

export async function resolve(id, quality) {
    const tidalId = String(id || '').replace(/^td:/, '');
    if (!/^\d+$/.test(tidalId)) return null;

    const tier = normaliseQuality(quality);
    return streamCache.wrap(`td:${tidalId}:${tier}`, async () => {
        for (const upstreamQuality of qualityAttempts(tier)) {
            const params = new URLSearchParams({ id: tidalId, quality: upstreamQuality });
            const payload = await fetchJson(`/track/?${params.toString()}`, 30000);
            const stream = decodeUnencryptedFlac(payload);
            if (stream) return stream;
        }
        return null;
    });
}

export const tidal = { id: PREFIX, key: 'tidal', name: 'Tidal', search, resolve };
