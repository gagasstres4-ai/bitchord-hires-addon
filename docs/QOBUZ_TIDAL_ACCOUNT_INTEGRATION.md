# Qobuz and TIDAL account integration status

## What a consumer subscription does (and does not) provide

A Qobuz or TIDAL consumer subscription does not itself issue third-party API
credentials or authorize this add-on to extract playback URLs from the official
apps. Do not put account passwords, browser cookies, session tokens, or
unofficially extracted secrets into Vercel environment variables.

### Qobuz

The repository's former default depended on the Soundfean public proxy. That
endpoint is not a supported Qobuz integration and must not be treated as a
reliable or official service. The add-on no longer silently calls it.

A legitimate Qobuz integration requires Qobuz-issued application credentials
and an approved API use case. Contact Qobuz through its official support/API
channel to ask about developer or partner access. Once credentials and
permitted playback endpoints are available, implement the official
authentication/signing flow server-side. Never commit credentials.

Official terms: https://static.qobuz.com/apps/api/QobuzAPI-TermsofUse.pdf

### TIDAL

The former default depended on third-party Aurix/Gglos endpoints. These are
not TIDAL-operated APIs and are no longer silently used.

TIDAL's official developer platform documents OAuth 2.1, including
authorization-code + PKCE for user-authorized access. Register an application
in the TIDAL Developer Portal, configure its exact redirect URI, and verify
that the scopes and track-manifest/playback capabilities granted to that
application permit the intended use. Catalog access alone does not guarantee
that a third-party player can receive a playable, unencrypted audio URL.
This repository must not bypass DRM or usage rules.

Official docs:
- https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization
- https://developer.tidal.com/reference

## Current behavior after this safety patch

- Qobuz and TIDAL providers return no results unless an explicitly configured,
  compatible upstream is supplied.
- Health reports either provider as `configured: false` when no upstream is
  configured; it no longer reports the retired hard-coded endpoint as a
  configured service.
- Monochrome, Netease, Internet Archive, and Deezer catalogue behavior remain
  unchanged.
- This patch does NOT claim to add native Qobuz/TIDAL subscription playback.
  That requires approved credentials and endpoint contracts first.

## Vercel

Do not set Qobuz/TIDAL environment variables to arbitrary proxy URLs. Once an
approved integration is available, add its server-side configuration in
Vercel Project → Settings → Environment Variables, then redeploy. Keep secrets
out of Git and out of client-visible responses.
