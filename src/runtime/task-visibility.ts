import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { logToFile } from '../logging/logger.js'

const execFileAsync = promisify(execFile)

export const DAEMON_TASK_NAME = 'Open Code Zen Router'

function isWindows(): boolean {
  return process.platform === 'win32'
}

function parseHiddenFromXml(xml: string): boolean | null {
  // schtasks /xml pretty-prints with newlines inside the element:
  //   <Hidden>true\r\n    </Hidden>
  // so allow anything (whitespace) between the tags.
  const match = xml.match(/<Hidden>([\s\S]*?)<\/Hidden>/i)
  if (!match) return null
  const value = match[1].trim().toLowerCase()
  if (value !== 'true' && value !== 'false') return null
  return value === 'true'
}

function decodeTaskOutput(stdout: unknown): string {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8')
  // schtasks /xml declares UTF-16 but actually emits console-encoded bytes
  // (UTF-8 on this box). Trust content, not the declaration: if UTF-8 parses
  // as XML with real tags, use it; only then fall back to UTF-16LE.
  const asUtf8 = buf.toString('utf8').replace(/^\uFEFF/, '')
  if (asUtf8.includes('<Settings>')) return asUtf8
  const start = buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0
  const asUtf16 = buf.slice(start).toString('utf16le')
  if (asUtf16.includes('<Settings>')) return asUtf16
  // Neither parses — return UTF-8 anyway so errors show real text, not mojibake.
  return asUtf8
}

async function readTaskXml(taskName: string): Promise<string> {
  // NB: /xml cannot be combined with /fo — bare /xml prints the task XML.
  const { stdout } = await execFileAsync(
    'schtasks',
    ['/query', '/tn', taskName, '/xml'],
    { timeout: 15000, encoding: 'buffer' as unknown as 'utf8' },
  )
  return decodeTaskOutput(stdout)
}

/** Current Hidden flag of the autostart task; absent tag reads as false (visible). */
export async function getDaemonHidden(taskName = DAEMON_TASK_NAME): Promise<boolean | null> {
  if (!isWindows()) return null
  try {
    const xml = await readTaskXml(taskName)
    // Absent <Hidden> = Windows default = visible console.
    if (!/<Hidden>/i.test(xml)) return false
    return parseHiddenFromXml(xml)
  } catch (err) {
    logToFile('warn', 'daemon visibility read failed', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function withHiddenFlag(xml: string, hidden: boolean): string {
  const value = hidden ? 'true' : 'false'
  if (/<Hidden>[\s\S]*?<\/Hidden>/i.test(xml)) {
    return xml.replace(/<Hidden>[\s\S]*?<\/Hidden>/i, `<Hidden>${value}</Hidden>`)
  }
  // Tag missing entirely (e.g. after a Set-ScheduledTask round-trip dropped
  // it): insert inside <Settings>, the schema-valid home for Hidden.
  // schtasks pretty-prints with \r\n blank lines, but the tag itself has no
  // attributes, so a plain substring search is the robust match.
  const idx = xml.indexOf('<Settings>')
  if (idx === -1) throw new Error('Task XML has no <Settings> element to host <Hidden>')
  const at = idx + '<Settings>'.length
  return xml.slice(0, at) + `\r\n    <Hidden>${value}</Hidden>` + xml.slice(at)
}

/**
 * Flip the Hidden flag via XML round-trip: export → modify → delete +
 * recreate. Set-ScheduledTask silently DROPS the Hidden element, so it can
 * never be the writer. Own user task, InteractiveToken — no elevation needed.
 * Caller restarts the task (stop/start) for the change to take effect.
 *
 * Serialized through a module-level promise chain: overlapping PUTs (rapid
 * clicks) execute strictly one-after-another, so concurrent writes can never
 * interleave. Each write is a single in-place overwrite — a failed create
 * leaves the original task untouched, so no rollback path is needed.
 */
const writeChains = new Map<string, Promise<void>>()

export function setDaemonHidden(hidden: boolean, taskName = DAEMON_TASK_NAME): Promise<void> {
  const prev = writeChains.get(taskName) ?? Promise.resolve()
  const run = prev.then(() => setDaemonHiddenInner(hidden, taskName))
  // Keep the chain alive across rejections; the caller still sees its error.
  // Per-task so parallel toggles for different tasks never block each other.
  writeChains.set(taskName, run.catch(() => {}))
  return run
}

async function setDaemonHiddenInner(hidden: boolean, taskName: string): Promise<void> {
  if (!isWindows()) throw new Error('Daemon visibility toggle is Windows-only')
  let xml: string
  try {
    xml = await readTaskXml(taskName)
  } catch (err) {
    throw new Error(`Could not read autostart task: ${err instanceof Error ? err.message : String(err)}`)
  }
  const updated = withHiddenFlag(xml, hidden)
  const tmpFile = join(tmpdir(), `zen-router-task-${Date.now()}-${Math.floor(Math.random() * 1e6)}.xml`)
  try {
    // Match what schtasks itself emits: UTF-16LE with BOM + CRLF newlines,
    // so /create accepts the file without re-encoding complaints.
    // NOTE: /create ... /f OVERWRITES in place — no /delete step. An earlier
    // delete+create design raced under rapid clicks (second delete landed
    // while the first create was in flight → "cannot find the file" on 4/5
    // writes). Overwrite is atomic from the caller's view, so no rollback
    // path is needed: a failed create leaves the original task untouched.
    await fs.writeFile(tmpFile, '\uFEFF' + updated.replace(/\r?\n/g, '\r\n'), 'utf16le')
    await execFileAsync('schtasks', ['/create', '/tn', taskName, '/xml', tmpFile, '/f'], { timeout: 30000 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logToFile('error', 'daemon visibility write failed', { error: msg })
    throw new Error(`Could not update task visibility: ${msg}`)
  } finally {
    await fs.unlink(tmpFile).catch(() => {})
  }
  // Confirm via the same read path the GET route uses, with a short settle
  // window: schtasks /create returns before the Task Scheduler service has
  // flushed the new XML to its store, so an immediate re-read can return the
  // previous value (observed: write true→false→true in flight, first read
  // still true). Retry ~6s before declaring a mismatch.
  let confirmed: boolean | null = null
  const deadline = Date.now() + 6000
  for (;;) {
    confirmed = await getDaemonHidden(taskName)
    if (confirmed === hidden || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (confirmed !== hidden) {
    throw new Error(`Task write accepted but still reads Hidden=${String(confirmed)}`)
  }
}
