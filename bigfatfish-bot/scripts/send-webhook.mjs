#!/usr/bin/env node
// BigFatFish webhook transport tool.
//
// Sends ONE signed GitHub-style webhook POST to the BigFatFish ingress so the
// Caddy rewrite / signature verification / routing path can be exercised.
// This is a transport-only tool: the default event is a harmless `ping`.
// Never use it with a payload that would trigger real business logic.
//
// Usage:
//   node scripts/send-webhook.mjs [--event <name>] [--payload <json>]
//                                 [--payload-file <path>] [--url <url>]
//                                 [--delivery <uuid>]
//
// Defaults: --event ping, --url http://127.0.0.1:5562/github, random delivery.
// Secret:   <repo-root>/.secrets/webhook-secret
//
// Exit code: 0 for HTTP 2xx, 1 for non-2xx HTTP or transport/argument errors.

import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..')
const SECRET_FILE = resolve(REPO_ROOT, '.secrets', 'webhook-secret')
const DEFAULT_URL = 'http://127.0.0.1:5562/github'
const DEFAULT_EVENT = 'ping'
const DEFAULT_PAYLOAD = '{"zen":"bigfatfish-verify","hook_id":0}'
const MAX_BODY_CHARS = 500

function die(message) {
  console.error(`send-webhook: ${message}`)
  process.exit(1)
}

function usage() {
  return [
    'Usage: node scripts/send-webhook.mjs [options]',
    '',
    'Options:',
    '  --event <name>          x-github-event value (default: ping)',
    '  --payload <json>        raw JSON body (mutually exclusive with --payload-file)',
    '  --payload-file <path>   read raw body from file (mutually exclusive with --payload)',
    '  --url <url>             webhook URL (default: ' + DEFAULT_URL + ')',
    '  --delivery <uuid>       x-github-delivery value (default: random UUID)',
    '  -h, --help              show this help',
  ].join('\n')
}

function parseArgs(argv) {
  const opts = {
    event: DEFAULT_EVENT,
    payload: undefined,
    payloadFile: undefined,
    url: DEFAULT_URL,
    delivery: undefined,
    help: false,
  }
  const valued = new Map([
    ['--event', 'event'],
    ['--payload', 'payload'],
    ['--payload-file', 'payloadFile'],
    ['--url', 'url'],
    ['--delivery', 'delivery'],
  ])

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=')
      const flag = eq === -1 ? arg : arg.slice(0, eq)
      const key = valued.get(flag)
      if (!key) die(`unknown option: ${arg}\n\n${usage()}`)
      let value
      if (eq !== -1) {
        value = arg.slice(eq + 1)
      } else {
        value = argv[++i]
        if (value === undefined || value.startsWith('--')) die(`missing value for ${flag}`)
      }
      opts[key] = value
      continue
    }
    die(`unexpected argument: ${arg}\n\n${usage()}`)
  }
  return opts
}

async function readSecret() {
  let raw
  try {
    raw = await readFile(SECRET_FILE, 'utf8')
  } catch (err) {
    die(`cannot read webhook secret at ${SECRET_FILE}: ${err.message}`)
  }
  // Secret files are usually newline-terminated; keep the secret bytes intact otherwise.
  return raw.replace(/\r?\n+$/, '')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(usage())
    return 0
  }
  if (opts.payload !== undefined && opts.payloadFile !== undefined) {
    die('--payload and --payload-file are mutually exclusive')
  }
  if (!opts.event) die('--event must not be empty')

  let rawBody
  if (opts.payloadFile !== undefined) {
    try {
      rawBody = await readFile(resolve(process.cwd(), opts.payloadFile), 'utf8')
    } catch (err) {
      die(`cannot read payload file ${opts.payloadFile}: ${err.message}`)
    }
  } else if (opts.payload !== undefined) {
    rawBody = opts.payload
  } else {
    rawBody = DEFAULT_PAYLOAD
  }

  // Fail fast on invalid JSON: the ingress validates JSON bodies.
  try {
    JSON.parse(rawBody)
  } catch (err) {
    die(`payload is not valid JSON: ${err.message}`)
  }

  const secret = await readSecret()
  if (!secret) die(`webhook secret at ${SECRET_FILE} is empty`)

  const delivery = opts.delivery ?? randomUUID()
  const signature = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const url = opts.url

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': opts.event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': signature,
        'user-agent': 'bigfatfish-verify',
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    console.error(`send-webhook: request to ${url} failed: ${err.message}`)
    return 1
  }

  const text = await res.text()
  const truncated = text.length > MAX_BODY_CHARS
    ? text.slice(0, MAX_BODY_CHARS) + '…'
    : text

  console.error(`send-webhook: url=${url} event=${opts.event} delivery=${delivery} bytes=${Buffer.byteLength(rawBody)}`)
  console.log(`HTTP ${res.status} ${res.statusText}`)
  console.log(truncated.length > 0 ? truncated : '<empty body>')

  return res.ok ? 0 : 1
}

main()
  .then((code) => { process.exitCode = code })
  .catch((err) => {
    console.error(`send-webhook: unexpected error: ${err && err.stack ? err.stack : err}`)
    process.exitCode = 1
  })
