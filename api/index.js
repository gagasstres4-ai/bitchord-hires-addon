import { searchAll, resolveStream, health } from '../lib/router.js';
import { getTidalDashManifest } from '../lib/providers/tidal.js';
import { createBitChordAuth } from '../lib/bitchord-addon-auth.mjs';
const bitchord = createBitChordAuth({
    hosts: ['bitchord-hires-addon.de.deplexo.com', 'bitchord-hires-addon.vercel.app', 'melonbread-hires-addon.vercel.app'],
});
const MANIFEST = {
    id: 'dev.akira.bitchord-hires',
    name: 'Melon Bread Hiress',
    version: '1.2.1',
    description: 'Multi-source lossless addon: Tidal HiFi, Monochrome, Netease, Deezer catalogue, Internet Archive. Tidal prefers compatible unencrypted Hi-Res FLAC and falls back to CD Lossless.',
    resources: ['search', 'stream'],
    bitchordAuth: true,
    checkValidLossless: 1,
    allowDownloads: 1,
    settings: [
        {
            key: 'quality',
            type: 'select',
            default: 'lossless',
            options: [
                { label: 'Best available Lossless (Hi-Res first, CD FLAC fallback)', value: 'lossless' },
                { label: 'High (FLAC, up to 24/96)', value: 'high' },
                { label: 'Low (data saver)', value: 'low' },
            ],
        },
        {
            key: 'atmos',
            type: 'select',
            default: 'stereo',
            options: [
                { label: 'Stereo only', value: 'stereo' },
                { label: 'Dolby Atmos when available', value: 'auto' },
            ],
        },
    ],
};
function json(res, status, body, extraHeaders = {}) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-BitChord-Token, X-BitChord-Proof',
        'Access-Control-Expose-Headers': 'WWW-Authenticate',
    };
    for (const [key, value] of Object.entries(extraHeaders)) {
        const existing = Object.keys(headers).find((name) => name.toLowerCase() === key.toLowerCase());
        if (existing)
            delete headers[existing];
        headers[key] = value;
    }
    res.writeHead(status, headers);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
export default async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/api/index.js' || path === '/api/index') {
        const original = url.searchParams.get('path');
        if (original !== null) {
            path = ('/' + original).replace(/\/+$/, '') || '/';
        }
    }
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-BitChord-Token, X-BitChord-Proof',
            'Access-Control-Max-Age': '86400',
        });
        return res.end();
    }
    if (req.method !== 'GET') {
        return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, OPTIONS' });
    }
    if (path === '/' || path === '/manifest.json') {
        return json(res, 200, MANIFEST);
    }
    // BitChord's player fetches DASH manifests directly, so this media route
    // is public like the signed segment URLs it contains. Only unencrypted
    // Tidal FLAC manifests are returned by getTidalDashManifest().
    if (path.startsWith('/dash/')) {
        const trackId = path.slice('/dash/'.length);
        if (!/^\d+$/.test(trackId))
            return json(res, 404, { error: 'invalid Tidal track id' });
        try {
            const manifest = await getTidalDashManifest(trackId);
            if (!manifest)
                return json(res, 404, { error: 'no compatible unencrypted Hi-Res manifest' });
            res.writeHead(200, {
                'Content-Type': 'application/dash+xml; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            });
            return res.end(manifest);
        } catch (err) {
            return json(res, 502, { error: String(err?.message || err) });
        }
    }
    const auth = await bitchord.verifyRequest(req);
    if (!auth.ok) {
        const rejection = bitchord.rejection(auth);
        return json(res, rejection.status, rejection.body, rejection.headers);
    }
    if (path === '/health') {
        try {
            const report = await health();
            return json(res, 200, report);
        }
        catch (err) {
            return json(res, 500, { ok: false, error: String(err?.message || err) });
        }
    }
    if (path === '/search') {
        const query = url.searchParams.get('q') || '';
        if (!query.trim())
            return json(res, 200, { tracks: [] });
        try {
            const { tracks, perSource } = await searchAll(query, url.searchParams.get('quality'));
            return json(res, 200, { tracks }, { 'X-Addon-Sources': encodeURIComponent(JSON.stringify(perSource)) });
        }
        catch (err) {
            return json(res, 200, { tracks: [], error: String(err?.message || err) });
        }
    }
    if (path.startsWith('/stream/')) {
        const id = decodeURIComponent(path.slice('/stream/'.length));
        if (!id)
            return json(res, 404, { error: 'missing id' });
        const stream = await resolveStream(id, url.searchParams.get('quality'));
        if (!stream)
            return json(res, 404, { error: 'not available in this addon' });
        if (stream.manifest === 'dash' && String(id).startsWith('td:')) {
            const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
                .split(',')[0].trim().toLowerCase();
            const allowedHosts = new Set([
                'bitchord-hires-addon.de.deplexo.com',
                'bitchord-hires-addon.vercel.app',
                'melonbread-hires-addon.vercel.app',
                'localhost',
                'localhost:8787',
                '127.0.0.1',
                '127.0.0.1:8787',
            ]);
            if (!allowedHosts.has(rawHost))
                return json(res, 500, { error: 'cannot construct a trusted DASH manifest URL for this host' });
            const scheme = rawHost.startsWith('localhost') || rawHost.startsWith('127.0.0.1') ? 'http' : 'https';
            const trackId = String(id).slice(3);
            stream.url = `${scheme}://${rawHost}/dash/${encodeURIComponent(trackId)}`;
        }
        return json(res, 200, stream);
    }
    return json(res, 404, { error: 'not found' });
}
