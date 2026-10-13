#!/usr/bin/env node
// Wrapper around node-pg-migrate that filters out the noisy
// "Can't determine timestamp for 00X" warnings on stderr.
//
// Our migration files are named `001_*.sql`, `002_*.sql`, … rather than
// `1700000000_*.sql`. node-pg-migrate prints a warning for each file
// whose name doesn't match its 13-digit-timestamp pattern. The warning
// is purely cosmetic — migrations still run in alphabetical order
// (which matches our intent). This wrapper drops just that one line
// from stderr and leaves everything else (including real errors)
// untouched.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const bin = path.join(repoRoot, 'node_modules', '.bin', 'node-pg-migrate')

const child = spawn(bin, ['up', '-m', 'migrations', '-j', 'sql'], {
  stdio: ['inherit', 'inherit', 'pipe'],
  cwd: repoRoot,
})

let buffer = ''
child.stderr.on('data', (chunk) => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (line.includes("Can't determine timestamp")) continue
    process.stderr.write(line + '\n')
  }
})

child.on('exit', (code) => {
  if (buffer && !buffer.includes("Can't determine timestamp")) {
    process.stderr.write(buffer)
  }
  process.exit(code ?? 1)
})

child.on('error', (err) => {
  process.stderr.write(`migrate wrapper failed to spawn: ${err.message}\n`)
  process.exit(1)
})
