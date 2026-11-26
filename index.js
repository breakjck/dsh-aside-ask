/**
 * Host half of the 旁问 (aside-ask) bundle.
 *
 * One quoted passage + one small question becomes one forked side conversation:
 * the child inherits the parent's completed turns, answers the small question,
 * and never speaks into the main conversation. When the child settles, a
 * one-line notice is queued for the parent's next pre-step so the main
 * conversation still knows the aside happened — appended as model-facing
 * context without waking an idle driver.
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROUTE = '/api/aside-ask'
/** Characters of the quoted passage kept in model-facing text. */
const QUOTE_LIMIT = 4000
/** Characters of the side answer kept in the main conversation's notice. */
const ANSWER_LIMIT = 4000
/** Earlier rounds of the same aside thread carried into a follow-up prompt. */
const HISTORY_LIMIT = 6
/** Characters of one earlier question kept in a follow-up prompt. */
const HISTORY_QUESTION_LIMIT = 400
/** Characters of one earlier answer kept in a follow-up prompt. */
const HISTORY_ANSWER_LIMIT = 1200

export const name = 'dsh-aside-ask'
export const inject = ['connection', 'subagents', 'agents']

/**
 * Register the ask route and the pre-step notice relay.
 * @param ctx - Host root context owning this bundle's row.
 */
export function apply(ctx) {
  /** Pending notices per parent session id; consumed by the next pre-step. */
  const notices = new Map()

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const sessionId = agent?.session?.id
    if (sessionId === undefined || sessionId === null) return decision
    const queued = notices.get(sessionId)
    if (queued === undefined || queued.length === 0) return decision
    notices.delete(sessionId)
    const messages = Array.isArray(decision.messages) ? decision.messages : []
    return { ...decision, messages: [...messages, ...queued] }
  }, { prepend: true })

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleAsk(ctx, notices, request),
  }), 'aside-ask: ask route')

  noteBoot()
}

/**
 * Record one line per apply, so "did the host half load" is answerable from disk
 * without opening a GUI.
 */
function noteBoot() {
  try {
    const line = `${new Date().toISOString()} aside-ask host applied (pid ${process.pid})\n`
    appendFileSync(join(tmpdir(), 'dsh-aside-ask-boot.log'), line, 'utf8')
  } catch { /* diagnostics must never break the plugin */ }
}

/**
 * Answer one ask request, streaming newline-delimited JSON events.
 * @param ctx - Host root context.
 * @param notices - Pending notice queue by parent session id.
 * @param request - Incoming `POST /api/aside-ask`.
 * @returns a stream of `{ type }` events, or a JSON error response.
 */
async function handleAsk(ctx, notices, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: { message: '请求体不是合法 JSON' } }, 400)
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const question = typeof body?.question === 'string' ? body.question.trim() : ''
  const quote = typeof body?.quote === 'string' ? body.quote.trim() : ''
  const history = readHistory(body?.history)
  if (sessionId === '' || question === '') {
    return json({ error: { message: '缺少会话或问题' } }, 400)
  }
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined || agent === null) {
    return json({ error: { message: '这个会话当前没有在运行，无法旁问' } }, 409)
  }

  const encoder = new TextEncoder()
  const abort = new AbortController()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
        } catch {
          closed = true
        }
      }
      const finish = () => {
        if (closed) return
        closed = true
        try { controller.close() } catch { /* already closed by the browser */ }
      }

      try {
        const activation = await startActivation(ctx, agent, question, quote, history, abort.signal)
        send({ type: 'started', childId: String(activation.childId) })
        const result = await activation.result
        const answer = blocksToText(result.output).trim()
        if (result.stopReason !== 'completed' || answer === '') {
          send({ type: 'error', message: failureText(result.stopReason) })
          return
        }
        send({ type: 'done', text: answer })
        queueNotice(notices, sessionId, quote, question, answer)
      } catch (error) {
        send({ type: 'error', message: messageOf(error) })
      } finally {
        finish()
      }
    },
    cancel() {
      closed = true
      abort.abort()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * Establish the side conversation, preferring the fork provider so the child
 * inherits the parent's completed turns, and falling back to a fresh child when
 * no fork provider is registered.
 * @param ctx - Host root context.
 * @param agent - The parent conversation's live agent.
 * @param question - The user's small question.
 * @param quote - The passage the user quoted.
 * @param history - Earlier rounds of the same thread, oldest first.
 * @param signal - Aborted when the browser drops the request.
 * @returns the activation handle.
 */
async function startActivation(ctx, agent, question, quote, history, signal) {
  const common = {
    label: `旁问：${truncate(question, 40)}`,
    prompt: [{ type: 'text', text: promptText(quote, question, history) }],
    parent: agent,
    signal,
    delivery: 'caller',
  }
  try {
    return await ctx.subagents.startActivation({ ...common, provider: 'fork' })
  } catch (forkError) {
    try {
      return await ctx.subagents.startActivation({ ...common, provider: 'spawn' })
    } catch {
      throw forkError
    }
  }
}

/**
 * Queue one notice for the parent's next pre-step.
 * @param notices - Pending notice queue by parent session id.
 * @param sessionId - Parent session id.
 * @param quote - The quoted passage.
 * @param question - The small question.
 * @param answer - The side conversation's answer.
 */
function queueNotice(notices, sessionId, quote, question, answer) {
  const text = [
    '[旁问] 用户在主对话里圈出一段内容，另开了一条旁支问了一个小问题，已经答完。',
    '这条只是记录：不必回应它，也不要据此改变当前任务；和正在做的事相关时可以作为参考。',
    '',
    `圈出的内容：${truncate(quote, QUOTE_LIMIT)}`,
    `问题：${question}`,
    `旁支回答：${truncate(answer, ANSWER_LIMIT)}`,
  ].join('\n')
  const message = {
    id: newMessageId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'aside-ask', form: 'notice', summary: truncate(`旁问：${question}`, 120) },
  }
  const queue = notices.get(sessionId)
  if (queue === undefined) notices.set(sessionId, [message])
  else queue.push(message)
}

/**
 * Read and bound the earlier rounds a follow-up carries.
 * @param value - The request's `history` field, of unknown shape.
 * @returns the accepted rounds, oldest first.
 */
function readHistory(value) {
  if (!Array.isArray(value)) return []
  const rounds = []
  for (const item of value.slice(-HISTORY_LIMIT)) {
    const question = typeof item?.question === 'string' ? item.question.trim() : ''
    const answer = typeof item?.answer === 'string' ? item.answer.trim() : ''
    if (question !== '' && answer !== '') rounds.push({ question, answer })
  }
  return rounds
}

/**
 * The child's instruction: answer the question, in the context of the earlier
 * rounds of this side thread and of the passage it is about.
 * @param quote - The quoted passage.
 * @param question - The user's question.
 * @param history - Earlier rounds of the same thread, oldest first.
 * @returns the child's first user message.
 */
function promptText(quote, question, history) {
  const lines = [
    '你是主对话的「旁问」执行者：只回答用户就下面这段内容提的问题。',
    '要求：直接回答这个问题本身，通常 1–4 句；不要续写主任务，不要反问；除非确实必要，不要调用工具。',
    '',
    '【用户圈出的内容】',
    truncate(quote, QUOTE_LIMIT),
  ]
  if (history.length > 0) {
    lines.push('', '【这个旁问窗口里已经聊过的】')
    for (const [index, round] of history.entries()) {
      lines.push(`第 ${index + 1} 问：${truncate(round.question, HISTORY_QUESTION_LIMIT)}`)
      lines.push(`第 ${index + 1} 答：${truncate(round.answer, HISTORY_ANSWER_LIMIT)}`)
    }
    lines.push(
      '',
      '用户这次的问题承接上面这些问答（例如“那第二个呢”指的是上文提到过的第二件事）；',
      '据此作答，不要重复已经答过的内容，也不要重新介绍背景。',
    )
  }
  lines.push('', '【用户这次的问题】', question)
  return lines.join('\n')
}

/**
 * Join the model-visible text of one result.
 * @param blocks - Result content blocks.
 * @returns the concatenated text.
 */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Explain why a side conversation produced no answer.
 * @param stopReason - The child's stop reason.
 * @returns the user-facing reason.
 */
function failureText(stopReason) {
  switch (stopReason) {
    case 'aborted': return '旁支被中止了'
    case 'max-tokens': return '旁支达到长度上限，没有给出完整答案'
    case 'refusal': return '旁支拒绝了这个问题'
    case 'error': return '旁支出错了'
    default: return '旁支没有给出答案'
  }
}

/**
 * Bound one string for logging or model-facing text.
 * @param value - Source text.
 * @param limit - Maximum characters.
 * @returns the original or an ellipsized prefix.
 */
function truncate(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * @param error - Anything thrown.
 * @returns its message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * @returns a fresh message identity.
 */
function newMessageId() {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  return `aside-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * @param body - JSON payload.
 * @param status - HTTP status.
 * @returns a JSON response.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
