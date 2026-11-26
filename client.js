/**
 * Client half of the 旁问 (aside-ask) bundle.
 *
 * A right-click on selected text in the chat opens one small window. The window
 * keeps the quoted passage, every question asked about it, and the answers in
 * order, and it stays open after an answer so the next question can follow. The
 * window is draggable by its header, remembers where it was dragged, and can be
 * closed and reopened.
 */
window.__ModuleLoader__.load({
  id: 'dsh-aside-ask',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'asideAsk'

    const zh = {
      'title': '旁问',
      'drag.grip': '⠿',
      'drag.hint': '按住这一行拖动 · 双击回到右下角',
      'action.ask': '问',
      'action.copy': '复制',
      'action.close': '关掉',
      'compose.quoted': '圈出的内容',
      'compose.hint': '接着问…（Ctrl+Enter 发送）',
      'compose.first': '就这段问一个小问题…（Ctrl+Enter 发送）',
      'compose.recorded': '答完会记进主对话',
      'status.asking': '旁支在想',
      'status.failed': '没答上来',
      'rounds.one': '1 轮',
      'rounds.many': '{count} 轮',
      'threads.one': '1 段引文',
      'threads.many': '{count} 段引文',
    }
    const en = {
      'title': 'Side ask',
      'drag.grip': '⠿',
      'drag.hint': 'Hold this row to drag · double-click to reset',
      'action.ask': 'Ask',
      'action.copy': 'Copy',
      'action.close': 'Dismiss',
      'compose.quoted': 'Quoted',
      'compose.hint': 'Ask a follow-up… (Ctrl+Enter to send)',
      'compose.first': 'Ask one small question about this… (Ctrl+Enter to send)',
      'compose.recorded': 'Noted to the main conversation',
      'status.asking': 'Thinking',
      'status.failed': 'No answer',
      'rounds.one': '1 round',
      'rounds.many': '{count} rounds',
      'threads.one': '1 quote',
      'threads.many': '{count} quotes',
    }

    const POSITION_KEY = 'dsh-aside-ask:position-v2'
    /** Shown in the header tooltip, so a stale bundle is obvious at a glance. */
    const VERSION = '0.3.0'
    /** Gap kept between the window and the viewport edges while dragging. */
    const EDGE = 8
    /** Default bottom-right anchor. */
    const ANCHOR = { right: '16px', bottom: '88px' }
    /** Rounds sent to the host as follow-up context. */
    const HISTORY_LIMIT = 6

    /**
     * Read the remembered free position of the window.
     * @returns the offset inside the viewport, or null for the default anchor.
     */
    function readPosition() {
      try {
        const raw = window.localStorage.getItem(POSITION_KEY)
        if (raw === null) return null
        const value = JSON.parse(raw)
        if (typeof value?.left !== 'number' || typeof value?.top !== 'number') return null
        if (!Number.isFinite(value.left) || !Number.isFinite(value.top)) return null
        return { left: value.left, top: value.top }
      } catch {
        return null
      }
    }

    /**
     * @param position - Fresh free position, or null to fall back to the anchor.
     */
    function writePosition(position) {
      try {
        if (position === null) window.localStorage.removeItem(POSITION_KEY)
        else window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
      } catch { /* storage may be unavailable */ }
    }

    /** Bounded breadcrumb trail, readable from the renderer's localStorage. */
    const TRACE_KEY = 'dsh-aside-ask:trace'
    const TRACE_LIMIT = 40

    /**
     * Record one step of the ask flow. Diagnostics only: it must never throw or
     * grow without bound, and it is the only way to see this state from outside
     * the running app.
     * @param event - Step name.
     * @param detail - Optional small payload.
     */
    function trace(event, detail) {
      try {
        const line = `${new Date().toISOString()} ${event}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`
        const previous = window.localStorage.getItem(TRACE_KEY)
        const lines = previous === null || previous === '' ? [] : previous.split('\n')
        lines.push(line)
        window.localStorage.setItem(TRACE_KEY, lines.slice(-TRACE_LIMIT).join('\n'))
      } catch { /* diagnostics must never break the UI */ }
    }

    /**
     * Read the current viewport box. The overlay slot may hand us a container
     * with no box of its own, so the window is bounded by the viewport instead
     * of by its containing block.
     * @returns the viewport width and height.
     */
    function viewportBox() {
      const root = document.documentElement
      return {
        width: window.innerWidth || (root ? root.clientWidth : 0) || 0,
        height: window.innerHeight || (root ? root.clientHeight : 0) || 0,
      }
    }

    /**
     * Keep the window inside the viewport so a drag can never strand it off
     * screen or behind the shell's clipped frame.
     * @param left - Wanted distance from the viewport's left edge.
     * @param top - Wanted distance from the viewport's top edge.
     * @param width - Window width.
     * @param height - Window height.
     * @returns the clamped offset.
     */
    function clampToViewport(left, top, width, height) {
      const viewport = viewportBox()
      const maxLeft = Math.max(EDGE, viewport.width - width - EDGE)
      const maxTop = Math.max(EDGE, viewport.height - height - EDGE)
      return {
        left: Math.min(Math.max(EDGE, left), maxLeft),
        top: Math.min(Math.max(EDGE, top), maxTop),
      }
    }

    let counter = 0
    /** @returns a fresh identity for a thread, round, or composer. */
    function nextKey() {
      counter += 1
      return `${Date.now().toString(36)}-${counter}`
    }

    /**
     * One thread per quoted passage; rounds accumulate under it in ask order.
     * The newest thread is the one the composer writes to.
     */
    const store = {
      sessionId: null,
      threads: [],
      position: readPosition(),
      listeners: new Set(),
      subscribe(listener) {
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      },
      notify() {
        for (const listener of [...store.listeners]) listener()
      },
      setPosition(position) {
        store.position = position
        writePosition(position)
        store.notify()
      },
      /**
       * Open the window for a quoted passage. Re-quoting the newest passage
       * keeps its thread (and its rounds) instead of stacking a duplicate.
       * @param sessionId - Conversation the quote came from.
       * @param quote - The selected text.
       */
      open(sessionId, quote) {
        const newest = store.threads[store.threads.length - 1]
        if (newest !== undefined && newest.quote === quote && newest.sessionId === sessionId) {
          trace('thread.reuse', { quote: quote.length })
          store.sessionId = sessionId
          store.notify()
          return
        }
        const thread = { id: nextKey(), sessionId, quote, rounds: [] }
        store.sessionId = sessionId
        store.threads = [...store.threads, thread]
        trace('thread.open', { quote: quote.length, threads: store.threads.length })
        store.notify()
      },
      /** Dismiss the whole window; the threads are dropped with it. */
      close() {
        if (store.threads.length === 0) return
        trace('window.close', { threads: store.threads.length })
        store.threads = []
        store.notify()
      },
      /** @returns the thread the composer writes to, or null. */
      active() {
        return store.threads.length === 0 ? null : store.threads[store.threads.length - 1]
      },
      /** @returns whether any round is still waiting for its answer. */
      busy() {
        return store.threads.some(thread => thread.rounds.some(round => round.status === 'asking'))
      },
      /**
       * Queue one question on a thread and stream its answer.
       * @param threadId - Thread to append to.
       * @param question - The user's question.
       */
      async ask(threadId, question) {
        const thread = store.threads.find(item => item.id === threadId)
        if (thread === undefined) return
        const round = { id: nextKey(), question, status: 'asking', answer: '', error: '' }
        const history = thread.rounds
          .filter(item => item.status === 'done' && item.answer !== '')
          .slice(-HISTORY_LIMIT)
          .map(item => ({ question: item.question, answer: item.answer }))
        thread.rounds = [...thread.rounds, round]
        trace('ask.start', { round: round.id, chars: question.length, history: history.length })
        store.notify()

        try {
          const response = await fetch('api/aside-ask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: thread.sessionId, quote: thread.quote, question, history }),
          })
          if (!response.ok) {
            let message = `${response.status}`
            try {
              const payload = await response.json()
              if (typeof payload?.error?.message === 'string') message = payload.error.message
            } catch { /* the body was not JSON */ }
            trace('ask.http', { status: response.status, message })
            store.settle(round.id, { status: 'error', error: message })
            return
          }
          const reader = response.body !== null && typeof response.body?.getReader === 'function'
            ? response.body.getReader()
            : null
          if (reader === null) {
            for (const line of (await response.text()).split('\n')) consume(round.id, line)
          } else {
            const decoder = new TextDecoder()
            let buffer = ''
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() ?? ''
              for (const line of lines) consume(round.id, line)
            }
            buffer += decoder.decode()
            if (buffer.trim() !== '') consume(round.id, buffer)
          }
          const settled = store.round(round.id)
          if (settled !== undefined && settled.status === 'asking') {
            store.settle(round.id, settled.answer === ''
              ? { status: 'error', error: '' }
              : { status: 'done' })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          trace('ask.threw', { message })
          store.settle(round.id, { status: 'error', error: message })
        }
      },
      /** @param id - Round identity. @returns that round, if still present. */
      round(id) {
        for (const thread of store.threads) {
          const found = thread.rounds.find(item => item.id === id)
          if (found !== undefined) return found
        }
        return undefined
      },
      /**
       * Apply one settled state to a round.
       * @param id - Round identity.
       * @param change - Fields to merge.
       */
      settle(id, change) {
        for (const thread of store.threads) {
          const index = thread.rounds.findIndex(item => item.id === id)
          if (index < 0) continue
          thread.rounds = thread.rounds.map((item, at) => (at === index ? { ...item, ...change } : item))
          store.notify()
          return
        }
      },
    }

    /**
     * Apply one newline-delimited event to a round.
     * @param id - Round identity.
     * @param line - One JSON event line.
     */
    function consume(id, line) {
      const text = line.trim()
      if (text === '') return
      let event
      try {
        event = JSON.parse(text)
      } catch {
        return
      }
      if (event?.type === 'done' && typeof event.text === 'string') {
        trace('ask.done', { chars: event.text.length })
        store.settle(id, { status: 'done', answer: event.text })
      } else if (event?.type === 'error') {
        const message = typeof event.message === 'string' ? event.message : ''
        trace('ask.error', { message })
        store.settle(id, { status: 'error', error: message })
      }
    }

    /**
     * @returns the shared store snapshot.
     */
    function useStore() {
      const [, force] = React.useReducer(value => value + 1, 0)
      React.useEffect(() => store.subscribe(force), [])
      return store
    }

    /**
     * Pointer-driven repositioning of the window. The window is `fixed`, so it
     * follows the pointer in viewport coordinates no matter which box the
     * overlay slot hands us. Moves are written straight to the node — no React
     * render runs in between — and the settled offset is committed on release.
     * @param stackRef - The window element.
     * @returns the props to spread on the window header.
     */
    function useDrag(stackRef) {
      const cleanupRef = React.useRef(null)

      React.useEffect(() => () => {
        if (cleanupRef.current !== null) cleanupRef.current()
      }, [])

      const onPointerDown = (event) => {
        if (!event.isPrimary || event.button !== 0) return
        const el = stackRef.current
        if (el === null) return
        if (event.target?.closest?.('button, a, input, textarea, select, [contenteditable="true"]') != null) return
        const box = el.getBoundingClientRect()
        const start = clampToViewport(box.left, box.top, box.width, box.height)
        el.style.position = 'fixed'
        el.style.left = `${start.left}px`
        el.style.top = `${start.top}px`
        el.style.right = 'auto'
        el.style.bottom = 'auto'
        el.setAttribute('data-aside-ask-dragging', '')
        try { window.getSelection()?.removeAllRanges() } catch { /* selection unavailable */ }

        const drag = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: start.left,
          top: start.top,
          width: box.width,
          height: box.height,
          next: start,
        }

        const onMove = (moveEvent) => {
          if (moveEvent.pointerId !== drag.pointerId) return
          const next = clampToViewport(
            drag.left + (moveEvent.clientX - drag.x),
            drag.top + (moveEvent.clientY - drag.y),
            drag.width,
            drag.height,
          )
          drag.next = next
          const node = stackRef.current
          if (node === null) return
          node.style.left = `${next.left}px`
          node.style.top = `${next.top}px`
          moveEvent.preventDefault()
        }

        const finish = () => {
          window.removeEventListener('pointermove', onMove, true)
          window.removeEventListener('pointerup', finish, true)
          window.removeEventListener('pointercancel', finish, true)
          window.removeEventListener('blur', finish)
          if (cleanupRef.current === finish) cleanupRef.current = null
          const node = stackRef.current
          if (node !== null) node.removeAttribute('data-aside-ask-dragging')
          store.setPosition(drag.next)
        }

        cleanupRef.current = finish
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', finish, true)
        window.addEventListener('pointercancel', finish, true)
        window.addEventListener('blur', finish)
        event.preventDefault()
      }

      /** Double-clicking the header parks the window back in the corner. */
      const reset = (event) => {
        if (event !== undefined) event.preventDefault()
        if (cleanupRef.current !== null) cleanupRef.current()
        store.setPosition(null)
      }

      return {
        handleProps: {
          onPointerDown,
          onDoubleClick: reset,
          style: {
            cursor: 'grab',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          },
        },
      }
    }

    /** Window itself: one panel that keeps its shape while rounds accumulate. */
    const stackStyle = {
      position: 'fixed',
      right: ANCHOR.right,
      bottom: ANCHOR.bottom,
      zIndex: 60,
      display: 'flex',
      flexDirection: 'column',
      width: 'min(400px, calc(100vw - 32px))',
      maxHeight: 'min(68vh, 560px)',
      borderRadius: '14px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.14))',
      background: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-button-floating-fill, #ffffff))',
      boxShadow: 'var(--dsw-elevation-panel, 0 12px 32px rgba(15, 23, 42, 0.22))',
      overflow: 'hidden',
      pointerEvents: 'auto',
      font: 'var(--dsw-font-xs-13, 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif)',
      color: 'var(--dsw-alias-text-primary, #1f2328)',
    }

    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flex: '0 0 auto',
      padding: '9px 10px 9px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(15, 23, 42, 0.08))',
      background: 'var(--dsw-alias-bg-raised, transparent)',
    }

    const bodyStyle = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      padding: '10px 12px',
      overscrollBehavior: 'contain',
    }

    const composerStyle = {
      flex: '0 0 auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '9px 10px 10px',
      borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(15, 23, 42, 0.08))',
      background: 'var(--dsw-alias-bg-raised, transparent)',
    }

    const threadStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    }

    const quoteStyle = {
      margin: 0,
      padding: '6px 9px',
      borderRadius: '8px',
      borderLeft: '2px solid var(--dsw-alias-accent, #3b6ef6)',
      background: 'var(--dsw-alias-bg-sunken, rgba(15, 23, 42, 0.045))',
      color: 'var(--dsw-alias-text-secondary, #4a5260)',
      fontSize: '12px',
      lineHeight: 1.5,
      display: '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
      wordBreak: 'break-word',
    }

    const roundStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '8px 10px',
      borderRadius: '10px',
      border: '1px solid var(--dsw-alias-border-subtle, rgba(15, 23, 42, 0.09))',
      background: 'var(--dsw-alias-bg-base, #ffffff)',
    }

    const questionStyle = {
      fontSize: '13px',
      fontWeight: 600,
      lineHeight: 1.5,
      wordBreak: 'break-word',
    }

    const answerStyle = {
      fontSize: '13px',
      lineHeight: 1.7,
      color: 'var(--dsw-alias-text-secondary, #3f4654)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }

    const hintStyle = {
      color: 'var(--dsw-alias-text-tertiary, #6b7280)',
      fontSize: '11px',
      lineHeight: 1.4,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    const iconButtonStyle = {
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-text-tertiary, #6b7280)',
      borderRadius: '6px',
      width: '20px',
      height: '20px',
      lineHeight: '16px',
      padding: 0,
      fontSize: '13px',
      cursor: 'pointer',
    }

    const sendStyle = {
      appearance: 'none',
      border: '1px solid transparent',
      borderRadius: '8px',
      padding: '4px 12px',
      font: 'inherit',
      fontSize: '12px',
      fontWeight: 600,
      cursor: 'pointer',
      background: 'var(--dsw-alias-accent, #3b6ef6)',
      color: 'var(--dsw-alias-text-on-accent, #ffffff)',
    }

    /** Animations, hover/focus states and scrollbar styling for the window. */
    const STYLE_ID = 'dsh-aside-ask-style'
    const CSS = `
      @keyframes dsh-aside-ask-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
      @keyframes dsh-aside-ask-fade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes dsh-aside-ask-dot { 0%, 80%, 100% { opacity: 0.25 } 40% { opacity: 1 } }
      [data-aside-ask="stack"] { animation: dsh-aside-ask-in 120ms ease-out both }
      [data-aside-ask="stack"][data-aside-ask-dragging] { animation: none; transition: none }
      [data-aside-ask="thread"] { animation: dsh-aside-ask-fade 140ms ease-out both }
      [data-aside-ask="round"] { animation: dsh-aside-ask-in 140ms ease-out both }
      [data-aside-ask="body"] { scrollbar-width: thin }
      [data-aside-ask="body"]::-webkit-scrollbar { width: 8px }
      [data-aside-ask="body"]::-webkit-scrollbar-track { background: transparent }
      [data-aside-ask="body"]::-webkit-scrollbar-thumb {
        background: var(--dsw-alias-border-l3, rgba(15, 23, 42, 0.18));
        border-radius: 999px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      [data-aside-ask="icon"]:hover { background: var(--dsw-alias-bg-hover, rgba(15, 23, 42, 0.06)) }
      [data-aside-ask="icon"]:focus-visible { outline: 2px solid var(--dsw-alias-accent, #3b6ef6); outline-offset: 1px }
      [data-aside-ask="send"]:hover:not(:disabled) { filter: brightness(1.06) }
      [data-aside-ask="send"]:active:not(:disabled) { transform: translateY(1px) }
      [data-aside-ask="send"]:disabled { opacity: 0.55; cursor: default }
      [data-aside-ask="send"]:focus-visible { outline: 2px solid var(--dsw-alias-accent, #3b6ef6); outline-offset: 2px }
      [data-aside-ask="copy"] { opacity: 0; transition: opacity 120ms ease-out }
      [data-aside-ask="round"]:hover [data-aside-ask="copy"],
      [data-aside-ask="copy"]:focus-visible { opacity: 1 }
      [data-aside-ask="dots"] span { animation: dsh-aside-ask-dot 1.2s infinite ease-in-out }
      [data-aside-ask="dots"] span:nth-child(2) { animation-delay: 0.15s }
      [data-aside-ask="dots"] span:nth-child(3) { animation-delay: 0.3s }
      [data-aside-ask="input"]::placeholder { color: var(--dsw-alias-text-tertiary, #6b7280) }
      [data-aside-ask="input"]:focus-visible {
        border-color: var(--dsw-alias-accent, #3b6ef6);
        box-shadow: 0 0 0 2px var(--dsw-alias-accent-soft, rgba(59, 110, 246, 0.18));
      }
      @media (prefers-reduced-motion: reduce) {
        [data-aside-ask="stack"], [data-aside-ask="thread"], [data-aside-ask="round"] { animation: none }
        [data-aside-ask="dots"] span { animation: none; opacity: 0.6 }
      }
    `

    /** @returns the style element, mounted once inside the window. */
    function StyleOnce() {
      return h('style', { 'data-aside-ask': 'style' }, CSS)
    }

    /**
     * Keep the scroll area pinned to the newest round while the user is already
     * at the bottom; scrolling up to read is never yanked away.
     * @param ref - Scroll container.
     * @param token - Value that changes whenever content grows.
     */
    function useStickToBottom(ref, token) {
      const stick = React.useRef(true)
      React.useEffect(() => {
        const el = ref.current
        if (el === null) return
        const onScroll = () => {
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }
        el.addEventListener('scroll', onScroll, { passive: true })
        return () => el.removeEventListener('scroll', onScroll)
      }, [ref])
      React.useEffect(() => {
        const el = ref.current
        if (el === null || !stick.current) return
        el.scrollTop = el.scrollHeight
      }, [ref, token])
    }

    /**
     * One question and its answer.
     * @returns the round element.
     */
    function Round({ round, t }) {
      const [copied, setCopied] = React.useState(false)
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(round.answer)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        } catch { /* clipboard access denied */ }
      }
      const asking = round.status === 'asking'
      return h('div', { style: roundStyle, 'data-aside-ask': 'round', 'data-state': round.status },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
          h('div', { style: { ...questionStyle, flex: '1', minWidth: 0 } }, round.question),
          round.status === 'done' && round.answer !== ''
            ? h('button', {
              type: 'button',
              style: iconButtonStyle,
              'data-aside-ask': 'copy',
              'aria-label': t('action.copy'),
              title: t('action.copy'),
              onClick: copy,
            }, copied ? '✓' : '⧉')
            : null,
        ),
        asking
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', ...hintStyle } },
            h('span', { style: { display: 'inline-flex', gap: '3px' }, 'data-aside-ask': 'dots' },
              h('span', null, '●'), h('span', null, '●'), h('span', null, '●')),
            h('span', null, t('status.asking')))
          : round.status === 'error'
            ? h('div', { style: { ...answerStyle, color: 'var(--dsw-alias-text-danger, #b42318)' } },
              round.error === '' ? t('status.failed') : `${t('status.failed')}：${round.error}`)
            : h('div', { style: answerStyle }, round.answer),
      )
    }

    /**
     * One quoted passage and every round asked about it.
     * @returns the thread element.
     */
    function Thread({ thread, t }) {
      return h('div', { style: threadStyle, 'data-aside-ask': 'thread' },
        h('blockquote', { style: quoteStyle, title: thread.quote }, thread.quote),
        thread.rounds.map(round => h(Round, { key: round.id, round, t })),
      )
    }

    /**
     * The input row. Stays mounted for as long as the window is open, so the
     * next question can be typed without touching the mouse again.
     * @returns the composer element.
     */
    function Composer({ t }) {
      const state = useStore()
      const active = state.active()
      const busy = state.busy()
      const [draft, setDraft] = React.useState('')
      const inputRef = React.useRef(null)

      React.useEffect(() => {
        inputRef.current?.focus()
      }, [state.threads.length])

      if (active === null) return null

      const submit = () => {
        const text = draft.trim()
        if (text === '' || busy) return
        setDraft('')
        store.ask(active.id, text)
        inputRef.current?.focus()
      }

      const onKeyDown = (event) => {
        // 输入法候选还没确认时，Enter/Ctrl+Enter 属于组字，不是发送
        if (event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229) return
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          submit()
        }
      }

      const placeholder = active.rounds.length === 0 ? t('compose.first') : t('compose.hint')
      return h('div', { style: composerStyle, 'data-aside-ask': 'composer' },
        h('textarea', {
          ref: inputRef,
          value: draft,
          rows: 2,
          placeholder,
          spellCheck: false,
          'data-aside-ask': 'input',
          onChange: event => setDraft(event.target.value),
          onKeyDown,
          style: {
            width: '100%',
            resize: 'none',
            minHeight: '40px',
            maxHeight: '120px',
            boxSizing: 'border-box',
            padding: '7px 9px',
            borderRadius: '9px',
            border: '1px solid var(--dsw-alias-border-subtle, rgba(15, 23, 42, 0.16))',
            background: 'var(--dsw-alias-bg-base, #ffffff)',
            color: 'inherit',
            font: 'inherit',
            lineHeight: 1.55,
            outline: 'none',
            transition: 'border-color 120ms ease-out, box-shadow 120ms ease-out',
          },
        }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { ...hintStyle, flex: '1' } }, t('compose.recorded')),
          h('button', {
            type: 'button',
            'data-aside-ask': 'send',
            style: sendStyle,
            disabled: busy || draft.trim() === '',
            onClick: submit,
          }, t('action.ask')),
        ),
      )
    }

    /**
     * Frame-wide overlay: the window header, the accumulating rounds and the
     * input row.
     * @returns the window element, or null when it is closed.
     */
    function Overlay({ t }) {
      const state = useStore()
      const stackRef = React.useRef(null)
      const bodyRef = React.useRef(null)
      const drag = useDrag(stackRef)
      const open = state.threads.length > 0
      const rounds = state.threads.reduce((total, thread) => total + thread.rounds.length, 0)
      const lastRound = rounds
      useStickToBottom(bodyRef, `${state.threads.length}:${lastRound}`)

      // A dragged window keeps its own offset; growing content must not carry it
      // past the viewport edge, and a resize must not strand it outside.
      React.useEffect(() => {
        const el = stackRef.current
        if (el === null) return
        const settle = () => {
          const current = store.position
          if (current === null) return
          const box = el.getBoundingClientRect()
          const next = clampToViewport(current.left, current.top, box.width, box.height)
          if (next.left !== current.left || next.top !== current.top) store.setPosition(next)
        }
        settle()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(settle) : null
        if (observer !== null) observer.observe(el)
        window.addEventListener('resize', settle)
        return () => {
          if (observer !== null) observer.disconnect()
          window.removeEventListener('resize', settle)
        }
      }, [open, rounds, state.threads.length])

      if (!open) return null
      const placed = state.position === null ? stackStyle : {
        ...stackStyle,
        left: `${state.position.left}px`,
        top: `${state.position.top}px`,
        right: 'auto',
        bottom: 'auto',
      }
      const summary = state.threads.length > 1
        ? t('threads.many', { count: state.threads.length })
        : (rounds === 0 ? '' : (rounds === 1 ? t('rounds.one') : t('rounds.many', { count: rounds })))
      return h('div', {
        ref: stackRef,
        style: placed,
        'data-aside-ask': 'stack',
        'data-aside-ask-version': VERSION,
      },
        h(StyleOnce),
        h('div', {
          ...drag.handleProps,
          style: { ...headerStyle, ...drag.handleProps.style },
          'data-aside-ask': 'header',
          title: `${t('title')} v${VERSION} — ${t('drag.hint')}`,
        },
          h('span', { style: { ...hintStyle, flex: '0 0 auto' } }, t('drag.grip')),
          h('strong', { style: { fontSize: '12px', fontWeight: 600, flex: '0 0 auto' } }, t('title')),
          h('span', { style: { ...hintStyle, flex: '1', textAlign: 'right' } }, summary),
          h('button', {
            type: 'button',
            'data-aside-ask': 'icon',
            style: iconButtonStyle,
            'aria-label': t('action.close'),
            title: t('action.close'),
            onClick: () => store.close(),
          }, '×'),
        ),
        h('div', { ref: bodyRef, style: bodyStyle, 'data-aside-ask': 'body' },
          state.threads.map(thread => h(Thread, { key: thread.id, thread, t })),
        ),
        h(Composer, { t }),
      )
    }

    /**
     * Read the current document selection when the chat did not classify the
     * right-click point as inside it — the same gesture, but the point landed a
     * pixel outside the highlight. The selection still has to live inside a chat
     * text source, so right-clicks anywhere else never open the window.
     * @returns the selected text, or null when there is nothing usable.
     */
    function selectionFallback() {
      try {
        const selection = document.getSelection()
        if (selection === null || selection.isCollapsed) return null
        const anchor = selection.anchorNode
        const element = anchor === null
          ? null
          : anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement
        if (element === null || element.closest('[data-text-interaction-source]') === null) return null
        const text = selection.toString().trim()
        return text === '' ? null : text
      } catch {
        return null
      }
    }

    return {
      inject: ['slots', 'locale', 'uiConversation', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aside-ask: dictionaries')
        ctx.effect(() => ctx.uiConversation.interactions.register({
          id: 'aside-ask',
          onInteraction(request) {
            if (request.trigger !== 'contextmenu') return
            const quoted = (request.hasSelection ? request.readText() : null) ?? selectionFallback()
            const length = quoted === null ? 0 : quoted.trim().length
            trace('gesture', { hasSelection: request.hasSelection, length })
            if (length === 0) return
            const binding = ctx.sessions.binding(request.sessionId)
            if (binding === undefined) {
              trace('gesture.noBinding')
              return
            }
            request.preventDefault()
            store.open(request.sessionId, quoted.trim())
          },
        }), 'aside-ask: context menu interaction')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'aside-ask.stack', locale: NS,
        }, Overlay))
      },
    }
  },
})
