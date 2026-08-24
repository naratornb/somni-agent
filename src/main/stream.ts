// Parser for `claude -p --output-format stream-json` output (NDJSON).
// Pure functions so this is testable without spawning anything.

export type StreamEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'result'; ok: boolean; costUsd?: number; durationMs?: number; detail?: string }

export function parseLine(line: string): StreamEvent | null {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch {
    return null // non-JSON noise on stdout is ignored
  }
  if (msg.type === 'system' && typeof msg.session_id === 'string') {
    return { kind: 'session', sessionId: msg.session_id }
  }
  if (msg.type === 'assistant') {
    const content = (msg.message as { content?: { type: string; text?: string }[] })?.content
    const text = (content ?? [])
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('')
    return text ? { kind: 'text', text } : null
  }
  if (msg.type === 'result') {
    return {
      kind: 'result',
      ok: msg.is_error !== true && msg.subtype === 'success',
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
      durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
      detail: typeof msg.result === 'string' ? msg.result : undefined
    }
  }
  return null
}

// Feed a raw stdout chunk into a line buffer; returns completed events and the
// unfinished remainder to carry into the next call.
export function feed(buffer: string, chunk: string): { events: StreamEvent[]; rest: string } {
  const lines = (buffer + chunk).split('\n')
  const rest = lines.pop() ?? ''
  const events: StreamEvent[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const ev = parseLine(line)
    if (ev) events.push(ev)
  }
  return { events, rest }
}
