// Line-buffering for a runner's NDJSON stdout. The per-runner parsing lives in
// the adapters (runners.ts); this stays runner-agnostic.

export type StreamEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'result'
      ok: boolean
      costUsd?: number
      durationMs?: number
      promptTokens?: number
      completionTokens?: number
      detail?: string
    }

export type ParseLine = (line: string) => StreamEvent | null

// Feed a raw stdout chunk into a line buffer; returns completed events and the
// unfinished remainder to carry into the next call.
export function feed(
  buffer: string,
  chunk: string,
  parseLine: ParseLine
): { events: StreamEvent[]; rest: string } {
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
