/**
 * OpenCode Zen serves the Responses API. Its `/v1/chat/completions` route
 * still exists, but returns 500 for the free contributor models, so a
 * config-declared provider (which always speaks chat/completions) cannot
 * reach Zen at all.
 *
 * This module translates chat/completions <-> responses for the Zen
 * upstream only, so those models stay reachable through the pool.
 */

const CHAT_COMPLETIONS_SUFFIX = '/chat/completions'

export function isChatCompletionsPath(path: string): boolean {
  return path.replace(/\/+$/, '').endsWith(CHAT_COMPLETIONS_SUFFIX)
}

/** Rewrite `/zen/v1/chat/completions` -> `/zen/v1/responses`, query preserved. */
export function toResponsesPath(url: string): string {
  const [path, ...rest] = url.split('?')
  const stripped = path.replace(/\/+$/, '')
  if (!stripped.endsWith(CHAT_COMPLETIONS_SUFFIX)) return url
  const rewritten = stripped.slice(0, -CHAT_COMPLETIONS_SUFFIX.length) + '/responses'
  return rest.length ? `${rewritten}?${rest.join('?')}` : rewritten
}

/**
 * chat/completions request body -> responses request body.
 * Returns null when the body is not parseable, so the caller can forward it
 * untouched rather than fail the request.
 */
export function toResponsesRequestBody(body: Buffer): Buffer | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const messages = parsed.messages
  if (!Array.isArray(messages)) return null

  const input = toResponsesInput(messages)
  // Null means a message part has no Responses equivalent (e.g. an
  // image_url or other non-text content part we cannot translate). Fail open
  // so the caller forwards the request natively instead of sending a
  // mistranslated body that the upstream would 400.
  if (!input) return null
  const translated: Record<string, unknown> = {
    model: parsed.model,
    input,
  }
  // The Responses API names the output budget differently. Both are passed
  // through verbatim: a caller's budget is the caller's choice, even though
  // reasoning models can spend all of it before emitting any text.
  if (parsed.max_tokens != null) translated.max_output_tokens = parsed.max_tokens
  if (parsed.max_completion_tokens != null) translated.max_output_tokens = parsed.max_completion_tokens
  if (parsed.max_output_tokens != null) translated.max_output_tokens = parsed.max_output_tokens
  for (const key of ['temperature', 'top_p', 'stream', 'metadata', 'parallel_tool_calls']) {
    if (parsed[key] !== undefined) translated[key] = parsed[key]
  }
  // Intentionally not forwarded: stop, seed, frequency_penalty,
  // presence_penalty, logit_bias, logprobs/top_logprobs, n, user, store and
  // service_tier have no Responses API equivalent, and forwarding unknown
  // fields risks an upstream 400. Translated requests therefore behave as the
  // defaults for those parameters.
  // chat/completions object-form tool_choice nests the name under `function`,
  // the same shape the tools array uses just below; the Responses API flattens
  // it onto the choice. String forms mean the same in both APIs and pass
  // through untouched.
  if (parsed.tool_choice !== undefined) {
    const choice = parsed.tool_choice
    const record = choice && typeof choice === 'object' ? choice as Record<string, unknown> : null
    const fn = record?.type === 'function' && record.function && typeof record.function === 'object'
      ? record.function as Record<string, unknown>
      : null
    translated.tool_choice = fn && typeof fn.name === 'string'
      ? { type: 'function', name: fn.name }
      : choice
  }
  // chat/completions names the effort budget top-level `reasoning_effort`; the
  // Responses API nests it under `reasoning.effort`.
  if (parsed.reasoning_effort !== undefined) {
    translated.reasoning = { effort: parsed.reasoning_effort }
  }
  // Structured output moves from `response_format` to `text.format`, and
  // json_schema's inner envelope is unwrapped. type:"text" is the Responses
  // default, so it is left unset rather than copied.
  const responseFormat = parsed.response_format as Record<string, unknown> | undefined
  if (responseFormat && typeof responseFormat === 'object') {
    if (responseFormat.type === 'json_object') {
      translated.text = { format: { type: 'json_object' } }
    } else if (responseFormat.type === 'json_schema' && responseFormat.json_schema && typeof responseFormat.json_schema === 'object') {
      translated.text = { format: { type: 'json_schema', ...(responseFormat.json_schema as Record<string, unknown>) } }
    }
  }
  // chat/completions nests the schema under `function`; the Responses API
  // expects it flattened onto the tool itself. Without this the upstream
  // rejects the request with "`tools[0]` missing required field `name`".
  if (Array.isArray(parsed.tools)) {
    translated.tools = parsed.tools.map((tool) => {
      if (!tool || typeof tool !== 'object') return tool
      const record = tool as Record<string, unknown>
      const fn = record.function
      if (record.type !== 'function' || !fn || typeof fn !== 'object') return tool
      const schema = fn as Record<string, unknown>
      return {
        type: 'function',
        name: schema.name,
        description: schema.description,
        parameters: schema.parameters,
        ...(schema.strict !== undefined ? { strict: schema.strict } : {}),
      }
    })
  }
  return Buffer.from(JSON.stringify(translated), 'utf8')
}

/**
 * chat/completions `messages` -> Responses `input`.
 *
 * Plain messages pass through with their text/image content translated (see
 * toResponsesContent). The two shapes that cannot pass through are an
 * assistant turn carrying `tool_calls` and a `role: "tool"` result: the
 * Responses API models those as standalone `function_call` /
 * `function_call_output` items rather than as message fields, so a
 * conversation replayed without this translation loses every tool exchange.
 *
 * Returns null when any message part has no Responses equivalent, so the
 * caller can fail open and forward the request natively.
 */
function toResponsesInput(messages: unknown[]): unknown[] | null {
  const input: unknown[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      input.push(message)
      continue
    }
    const record = message as Record<string, unknown>

    if (record.role === 'tool') {
      const content = record.content
      input.push({
        type: 'function_call_output',
        call_id: record.tool_call_id,
        output: typeof content === 'string' ? content : JSON.stringify(content ?? ''),
      })
      continue
    }

    const toolCalls = record.tool_calls
    if (record.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length > 0) {
      if (record.content) {
        const content = toResponsesContent(record.content)
        if (content === null) return null
        input.push({ role: 'assistant', content })
      }
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object') continue
        const entry = call as Record<string, unknown>
        const fn = (entry.function ?? {}) as Record<string, unknown>
        input.push({
          type: 'function_call',
          call_id: entry.id,
          name: fn.name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        })
      }
      continue
    }

    if (typeof record.content !== 'string' && record.content !== undefined && record.content !== null) {
      const content = toResponsesContent(record.content)
      if (content === null) return null
      input.push({ ...record, content })
      continue
    }

    input.push(record)
  }
  return input
}

/**
 * chat `content` (string or parts array) -> Responses `content`.
 * Returns null for parts with no Responses equivalent.
 */
function toResponsesContent(content: unknown): unknown {
  if (typeof content === 'string' || content == null) return content
  if (!Array.isArray(content)) return null
  const out: unknown[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string') {
      out.push({ type: 'input_text', text: p.text })
    } else if (p.type === 'input_text' || p.type === 'input_image') {
      out.push(part)
    } else if (p.type === 'image_url') {
      const raw = p.image_url
      const url = typeof raw === 'string' ? raw : (raw as Record<string, unknown> | undefined)?.url
      if (typeof url !== 'string') return null
      const image: Record<string, unknown> = { type: 'input_image', image_url: url }
      if (typeof (raw as Record<string, unknown> | undefined)?.detail === 'string') {
        image.detail = (raw as Record<string, unknown>).detail
      }
      out.push(image)
    } else {
      return null
    }
  }
  return out
}

function collectText(output: unknown): string {
  if (!Array.isArray(output)) return ''
  let text = ''
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type !== 'message') continue
    const content = record.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p.type === 'output_text' && typeof p.text === 'string') {
        text += p.text
      } else if (p.type === 'refusal' && typeof p.refusal === 'string') {
        text += p.refusal
      }
    }
  }
  return text
}

function collectToolCalls(output: unknown): Record<string, unknown>[] {
  if (!Array.isArray(output)) return []
  const calls: Record<string, unknown>[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type !== 'function_call') continue
    calls.push({
      id: record.call_id ?? record.id,
      type: 'function',
      function: { name: record.name, arguments: record.arguments ?? '{}' },
    })
  }
  return calls
}

function finishReason(status: unknown): string {
  return status === 'incomplete' ? 'length' : 'stop'
}

/** Stable key for matching a streaming tool call across added/delta/done events. */
function toolCallKey(outputIndex: unknown, item: Record<string, unknown>): string | null {
  if (typeof outputIndex === 'number') return `index:${outputIndex}`
  for (const field of ['item_id', 'call_id', 'id']) {
    const value = item[field]
    if (typeof value === 'string' && value) return `${field}:${value}`
  }
  return null
}

function mapUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const mapped: Record<string, unknown> = {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
  }
  const inputDetails = u.input_tokens_details as Record<string, unknown> | undefined
  if (inputDetails && typeof inputDetails.cached_tokens === 'number') {
    mapped.prompt_tokens_details = { cached_tokens: inputDetails.cached_tokens }
  }
  const outputDetails = u.output_tokens_details as Record<string, unknown> | undefined
  if (outputDetails && typeof outputDetails.reasoning_tokens === 'number') {
    mapped.completion_tokens_details = { reasoning_tokens: outputDetails.reasoning_tokens }
  }
  return mapped
}

/** Non-streaming responses payload -> chat/completions payload. */
export function toChatCompletion(payload: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(payload)
  } catch {
    return payload
  }
  // Upstream errors are already shaped as {error: ...}; pass them through so
  // the client sees the real failure rather than an empty completion.
  if (!parsed || typeof parsed !== 'object' || parsed.error) return payload
  if (parsed.object !== 'response') return payload

  const toolCalls = collectToolCalls(parsed.output)
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: collectText(parsed.output) || null,
  }
  if (toolCalls.length) message.tool_calls = toolCalls

  return JSON.stringify({
    id: parsed.id,
    object: 'chat.completion',
    created: parsed.created_at ?? Math.floor(Date.now() / 1000),
    model: parsed.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? 'tool_calls' : finishReason(parsed.status),
      },
    ],
    usage: mapUsage(parsed.usage),
  })
}

/**
 * Translate one Responses SSE event into zero or more chat.completion.chunk
 * SSE frames. Stateful only in the sense that the caller feeds events in
 * order; `id`/`model` are carried by the caller.
 */
export class SseTranslator {
  private id = 'chatcmpl-zen'
  private model = ''
  private roleSent = false
  private toolCallIndex = 0
  // Incremental tool-call args keyed by the Responses output position (or item
  // id when no index is present). A key is present once its opening frame has
  // been emitted, so the terminal output_item.done can stay silent instead of
  // re-emitting args the client already accumulated.
  private readonly streamedToolCalls = new Map<string, number>()
  private readonly includeUsage: boolean

  // A chat/completions client sees usage only when it asked for it via
  // stream_options.include_usage; the Responses stream always carries it in
  // response.completed, so we must remember the client's choice and emit a
  // usage chunk only when it opted in.
  constructor(includeUsage = false) {
    this.includeUsage = includeUsage
  }

  translate(eventName: string, data: string): string {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data)
    } catch {
      return ''
    }

    if (eventName === 'response.created' || eventName === 'response.in_progress') {
      const response = parsed.response as Record<string, unknown> | undefined
      if (response) {
        if (typeof response.id === 'string') this.id = response.id
        if (typeof response.model === 'string') this.model = response.model
      }
      if (eventName === 'response.created' && !this.roleSent) {
        this.roleSent = true
        return this.frame({ role: 'assistant', content: '' }, null)
      }
      return ''
    }

    // A tool call arrives complete on output_item.done rather than as text
    // deltas, so a model that sends no incremental args is emitted as a single
    // tool_calls frame. `index` must count tool calls only - numbering them by
    // output position would leave gaps that clients accumulate into the wrong
    // slot. When incremental function_call_arguments.delta events were already
    // streamed for this call, done stays silent so args are not duplicated.
    if (eventName === 'response.output_item.done') {
      const item = parsed.item as Record<string, unknown> | undefined
      if (!item || item.type !== 'function_call') return ''
      const key = toolCallKey(parsed.output_index, item)
      const known = key !== null ? this.streamedToolCalls.get(key) : undefined
      if (known !== undefined) return ''
      const index = this.toolCallIndex++
      if (key !== null) this.streamedToolCalls.set(key, index)
      return this.frame({
        tool_calls: [
          {
            index,
            id: item.call_id ?? item.id,
            type: 'function',
            function: { name: item.name, arguments: item.arguments ?? '{}' },
          },
        ],
      }, null)
    }

    if (eventName === 'response.output_item.added') {
      const item = parsed.item as Record<string, unknown> | undefined
      if (!item || item.type !== 'function_call') return ''
      const key = toolCallKey(parsed.output_index, item)
      if (key !== null && this.streamedToolCalls.has(key)) return ''
      const index = this.toolCallIndex++
      if (key !== null) this.streamedToolCalls.set(key, index)
      return this.frame({
        tool_calls: [
          {
            index,
            id: item.call_id ?? item.id,
            type: 'function',
            function: { name: item.name, arguments: '' },
          },
        ],
      }, null)
    }

    if (eventName === 'response.function_call_arguments.delta') {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
      if (!delta) return ''
      const key = toolCallKey(parsed.output_index, parsed as Record<string, unknown>)
      let index = key !== null ? this.streamedToolCalls.get(key) : undefined
      if (index === undefined) {
        index = this.toolCallIndex++
        if (key !== null) this.streamedToolCalls.set(key, index)
      }
      return this.frame({
        tool_calls: [{ index, function: { arguments: delta } }],
      }, null)
    }

    if (eventName === 'response.output_text.delta') {
      const delta = typeof parsed.delta === 'string' ? parsed.delta : ''
      if (!delta) return ''
      return this.frame({ content: delta }, null)
    }

    if (eventName === 'response.completed' || eventName === 'response.incomplete') {
      const response = parsed.response as Record<string, unknown> | undefined
      const reason = this.toolCallIndex > 0 ? 'tool_calls' : finishReason(response?.status)
      const usage = this.includeUsage ? mapUsage(response?.usage) : undefined
      return this.frame({}, reason) + this.usageFrame(usage) + 'data: [DONE]\n\n'
    }

    if (eventName === 'response.failed' || eventName === 'error') {
      return `data: ${JSON.stringify({ error: (parsed.error ?? parsed) as unknown })}\n\ndata: [DONE]\n\n`
    }

    return ''
  }

  private frame(delta: Record<string, unknown>, reason: string | null): string {
    const chunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: reason }],
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  // Usage is reported in a dedicated final frame with an empty choices array,
  // the shape a chat/completions client expects when include_usage is set.
  private usageFrame(usage: Record<string, unknown> | undefined): string {
    if (!usage) return ''
    const chunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [],
      usage,
    }
    return `data: ${JSON.stringify(chunk)}\n\n`
  }
}
