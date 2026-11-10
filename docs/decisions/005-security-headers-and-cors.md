# Decision Record 005: Content Security Policy Directives and API CORS Policy

## Status
Accepted

## Context
Production web applications require defense-in-depth protection against Cross-Site Scripting (XSS), clickjacking, MIME confusion, and unauthorized cross-origin data extraction.
RepoStory uses:
- Next.js with React 19
- Tailwind CSS for utility styling
- React Flow (@xyflow/react) for rendering interactive architecture diagrams
- NextAuth for GitHub OAuth authentication

## Decisions

### 1. Content Security Policy (CSP) Directives
- **`default-src 'self'`**: All unspecified resources must load from the origin.
- **`style-src 'self' 'unsafe-inline'`**: Required. Tailwind CSS and React Flow compute dynamic coordinates and styling inline on SVG and DOM nodes for zoom/pan, dragging, and interactive workflows. Attempting to enforce nonce-only styles breaks React Flow node dragging and dynamic theme updates.
- **`img-src 'self' data: https://avatars.githubusercontent.com https://github.com`**: Allows local assets, data URIs for diagram SVG export, and GitHub avatars for user sessions.
- **`connect-src 'self' https://api.github.com https://*.supabase.co https://*.ingest.sentry.io https://*.upstash.io`**: Whitelists GitHub API, Supabase backend, Sentry error telemetry, and Upstash Redis rate limiting.
- **`frame-ancestors 'none'`**: Completely blocks framing (mitigates clickjacking), reinforced by `X-Frame-Options: DENY`.
- **`object-src 'none'`** and **`base-uri 'self'`**: Hardens against plugin and base tag hijacking.

### 2. Transport & Framing Security
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

### 3. API CORS Policy
- By default, `/api/*` endpoints are closed to cross-origin browsers (`Access-Control-Allow-Origin` is omitted, and preflight `OPTIONS` requests from unauthorized origins return `403 Forbidden`).
- If an authorized external frontend needs access, allowed origins must be configured in `CORS_ALLOWED_ORIGINS` (comma-separated list).
- Wildcard `*` reflection of incoming `Origin` headers is strictly disallowed.
