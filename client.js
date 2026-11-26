/**
 * Client half of the 旁问 (aside-ask) bundle.
 *
 * A right-click on selected text in the chat opens a small frame-wide composer.
 * Asking runs one side conversation on the Host and streams its answer into a
 * card in the bottom-right corner, so the main conversation keeps its place.
 */
window.__ModuleLoader__.load({
  id: 'dsh-aside-ask',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'asideAsk'

    const zh = {
      'title': '旁问',
      'compose.quoted': '圈出的内容',
      'compose.hint': '就这段问一个小问题…（Ctrl+Enter 发送）',
      'action.ask': '问',
      'action.cancel': '取消',
      'action.copy': '复制',
      'action.close': '关掉',
      'status.asking': '旁支在想…',
      'status.failed': '没答上来',
      'note.recorded': '答完会在你下次开口时记进主对话',
      'error.noSession': '这个会话现在不能旁问',
      'error.network': '请求失败',
      'drag.hint': '按住这一行拖动 · 双击回到右下角',
      'drag.grip': '⠿',
    }
    const en = {
      'title': 'Side ask',
      'compose.quoted': 'Quoted',
      'compose.hint': 'Ask one small question about this… (Ctrl+Enter to send)',
      'action.ask': 'Ask',
      'action.cancel': 'Cancel',
      'action.copy': 'Copy',
      'action.close': 'Dismiss',
      'status.asking': 'Asking…',
      'status.failed': 'No answer',
      'note.recorded': 'Will be noted to the main conversation at your next turn',
      'error.noSession': 'This conversation cannot be asked right now',
      'error.network': 'Request failed',
      'drag.hint': 'Hold this row to drag · double-click to reset',
      'drag.grip': '⠿',
    }

    const POSITION_KEY = 'dsh-aside-ask:position-v2'
    /** Shown in the header tooltip, so a stale bundle is obvious at a glance. */
    const VERSION = '0.2.1'
    /** Gap kept between the stack and the viewport edges while dragging. */
    const EDGE = 8
    /** Size of the default bottom-right anchor. */
    const ANCHOR = { right: '16px', bottom: '88px' }

    /**
     * Read the remembered free position of the stack.
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

    /**
     * Read the current viewport box. The overlay slot may hand us a container
     * with no box of its own, so the stack is bounded by the window instead of
     * by its containing block.
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
     * Keep the stack inside the viewport so a drag can never strand it off
     * screen or behind the shell's clipped frame.
     * @param left - Wanted distance from the viewport's left edge.
     * @param top - Wanted distance from the viewport's top edge.
     * @param width - Stack width.
     * @param height - Stack height.
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

    /** Frame-wide state shared by the gesture handler and the overlay card. */
    const store = {
      composer: null,
      items: [],
      position: readPosition(),
      listeners: new Set(),
      subscribe(listener) {
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      },
      notify() {
        for (const listener of [...store.listeners]) listener()
      },
      /**
       * @param position - New free position, or null to return to the anchor.
       */
      setPosition(position) {
        store.position = position
        writePosition(position)
        store.notify()
      },
      open(sessionId, quote) {
        store.composer = { sessionId, quote, key: nextKey() }
        store.notify()
      },
      close() {
        if (store.composer === null) return
        store.composer = null
        store.notify()
      },
      dismissItem(id) {
        store.items = store.items.filter(item => item.id !== id)
        store.notify()
      },
      patch(id, change) {
        store.items = store.items.map(item => (item.id === id ? { ...item, ...change } : item))
        store.notify()
      },
      item(id) {
        return store.items.find(item => item.id === id)
      },
      async ask(sessionId, quote, question) {
        const id = nextKey()
        store.items = [...store.items, { id, quote, question, status: 'asking', text: '', error: '' }].slice(-8)
        store.composer = null
        store.notify()
        try {
          const response = await fetch('api/aside-ask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, question, quote }),
          })
          if (!response.ok) {
            let message = `${response.status}`
            try {
              const payload = await response.json()
              if (typeof payload?.error?.message === 'string') message = payload.error.message
            } catch { /* the body was not JSON */ }
            store.patch(id, { status: 'error', error: message })
            return
          }
          const reader = response.body !== null && typeof response.body?.getReader === 'function'
            ? response.body.getReader()
            : null
          if (reader === null) {
            for (const line of (await response.text()).split('\n')) consume(id, line)
          } else {
            const decoder = new TextDecoder()
            let buffer = ''
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split('\n')
              buffer = lines.pop() ?? ''
              for (const line of lines) consume(id, line)
            }
            buffer += decoder.decode()
            if (buffer.trim() !== '') consume(id, buffer)
          }
          const settled = store.item(id)
          if (settled !== undefined && settled.status === 'asking') {
            store.patch(id, settled.text === ''
              ? { status: 'error', error: '' }
              : { status: 'done' })
          }
        } catch (error) {
          store.patch(id, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }

    /**
     * Apply one newline-delimited event to a card.
     * @param id - Card identity.
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
        store.patch(id, { status: 'done', text: event.text })
      } else if (event?.type === 'error') {
        store.patch(id, { status: 'error', error: typeof event.message === 'string' ? event.message : '' })
      }
    }

    let counter = 0
    function nextKey() {
      counter += 1
      return `${Date.now().toString(36)}-${counter}`
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
     * Pointer-driven repositioning of the stack. The stack is `fixed`, so it
     * follows the pointer in viewport coordinates no matter which box the
     * overlay slot hands us. Moves are written straight to the node — no React
     * render runs in between, which used to clobber the first move — and the
     * settled offset is committed to the store on release.
     * @param stackRef - The stack element.
     * @returns the props to spread on a panel header.
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
        el.style.cursor = 'grabbing'
        el.setAttribute('data-aside-ask-dragging', '')
        // Take the drag away from any live selection so the pointer stream
        // stays ours for the whole gesture.
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
          if (node !== null) {
            node.style.cursor = ''
            node.removeAttribute('data-aside-ask-dragging')
          }
          store.setPosition(drag.next)
        }

        cleanupRef.current = finish
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', finish, true)
        window.addEventListener('pointercancel', finish, true)
        window.addEventListener('blur', finish)
        event.preventDefault()
      }

      /** Double-clicking a header parks the stack back in the corner. */
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

    /**
     * @param drag - Result of {@link useDrag}.
     * @returns props for a panel header row.
     */
    function headerProps(drag) {
      return {
        ...drag.handleProps,
        style: { ...headerStyle, ...drag.handleProps.style },
      }
    }

    /**
     * The stack itself. It starts anchored to the bottom-right corner and is
     * `fixed`, so a dragged `left`/`top` is measured against the viewport and
     * never depends on the containing block the overlay slot creates.
     */
    const card = {
      position: 'fixed',
      right: ANCHOR.right,
      bottom: ANCHOR.bottom,
      zIndex: 60,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      width: 'min(380px, calc(100vw - 32px))',
      maxHeight: 'min(64vh, 520px)',
      pointerEvents: 'none',
      font: 'var(--dsw-font-xs-13, 13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif)',
      color: 'var(--dsw-alias-text-primary, #1f2328)',
    }

    /** Header row shared by every panel; it doubles as the drag handle. */
    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minHeight: '18px',
    }

    const panel = {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      padding: '10px 12px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border-subtle, rgba(15, 23, 42, 0.12))',
      background: 'var(--dsw-alias-bg-raised, var(--dsw-alias-button-floating-fill, #ffffff))',
      boxShadow: 'var(--dsw-elevation-panel, 0 8px 28px rgba(15, 23, 42, 0.18))',
      overflowY: 'auto',
      pointerEvents: 'auto',
    }

    const quoteStyle = {
      margin: 0,
      padding: '6px 8px',
      borderRadius: '8px',
      borderLeft: '3px solid var(--dsw-alias-accent, #3b6ef6)',
      background: 'var(--dsw-alias-bg-sunken, rgba(15, 23, 42, 0.045))',
      color: 'var(--dsw-alias-text-secondary, #4a5260)',
      display: '-webkit-box',
      WebkitLineClamp: 3,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
      wordBreak: 'break-word',
    }

    const buttonStyle = {
      appearance: 'none',
      border: '1px solid var(--dsw-alias-border-subtle, rgba(15, 23, 42, 0.14))',
      background: 'transparent',
      color: 'inherit',
      borderRadius: '8px',
      padding: '3px 10px',
      font: 'inherit',
      cursor: 'pointer',
    }

    const primaryStyle = {
      ...buttonStyle,
      border: '1px solid transparent',
      background: 'var(--dsw-alias-accent, #3b6ef6)',
      color: 'var(--dsw-alias-text-on-accent, #ffffff)',
    }

    const mutedStyle = {
      color: 'var(--dsw-alias-text-tertiary, #6b7280)',
      fontSize: '11px',
    }

    /**
     * The composer that replaces the native context menu for a selection.
     * @returns the composer element, or null while closed.
     */
    function Composer({ t, drag }) {
      const state = useStore()
      const composer = state.composer
      const [question, setQuestion] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const inputRef = React.useRef(null)

      React.useEffect(() => {
        setQuestion('')
        setBusy(false)
        inputRef.current?.focus()
      }, [composer?.key])

      if (composer === null || composer === undefined) return null

      const submit = () => {
        const text = question.trim()
        if (text === '' || busy) return
        setBusy(true)
        store.ask(composer.sessionId, composer.quote, text)
      }

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          store.close()
          return
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          submit()
        }
      }

      return h('div', { style: { ...panel, gap: '6px' } },
        h('div', {
          ...headerProps(drag),
          title: `${t('title')} v${VERSION} — ${t('drag.hint')}`,
        },
          h('span', { style: { ...mutedStyle, flex: '0 0 auto', lineHeight: 1 } }, t('drag.grip')),
          h('strong', { style: { fontSize: '12px', letterSpacing: '0.02em', flex: '0 0 auto' } }, t('title')),
          h('span', { style: { ...mutedStyle, flex: '1' } }, t('compose.quoted')),
          h('button', {
            type: 'button',
            style: mutedStyle,
            'aria-label': t('action.cancel'),
            onClick: () => store.close(),
          }, '×'),
        ),
        h('blockquote', { style: quoteStyle }, composer.quote),
        h('textarea', {
          ref: inputRef,
          value: question,
          rows: 2,
          placeholder: t('compose.hint'),
          spellCheck: false,
          onChange: event => setQuestion(event.target.value),
          onKeyDown,
          style: {
            width: '100%',
            resize: 'vertical',
            minHeight: '48px',
            boxSizing: 'border-box',
            padding: '6px 8px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-subtle, rgba(15, 23, 42, 0.16))',
            background: 'var(--dsw-alias-bg-base, #ffffff)',
            color: 'inherit',
            font: 'inherit',
            outline: 'none',
          },
        }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { style: { ...mutedStyle, flex: '1' } }, t('note.recorded')),
          h('button', { type: 'button', style: buttonStyle, onClick: () => store.close() }, t('action.cancel')),
          h('button', {
            type: 'button',
            style: { ...primaryStyle, opacity: question.trim() === '' || busy ? 0.55 : 1 },
            disabled: question.trim() === '' || busy,
            onClick: submit,
          }, t('action.ask')),
        ),
      )
    }

    /**
     * One side conversation card.
     * @returns the card element.
     */
    function Card({ item, t, drag }) {
      const [copied, setCopied] = React.useState(false)
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(item.text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch { /* clipboard access denied */ }
      }
      const body = item.status === 'asking'
        ? h('div', { style: mutedStyle }, t('status.asking'))
        : item.status === 'error'
          ? h('div', { style: { color: 'var(--dsw-alias-text-danger, #b42318)' } },
            item.error === '' ? t('status.failed') : `${t('status.failed')}：${item.error}`)
          : h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, item.text)

      return h('div', { style: { ...panel, maxHeight: 'none' } },
        h('div', {
          ...headerProps(drag),
          title: `${t('title')} v${VERSION} — ${t('drag.hint')}`,
        },
          h('span', { style: { ...mutedStyle, flex: '0 0 auto', lineHeight: 1 } }, t('drag.grip')),
          h('strong', { style: { fontSize: '12px', flex: '0 0 auto' } }, t('title')),
          h('span', {
            style: {
              ...mutedStyle,
              flex: '1',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, item.question),
          item.status === 'done'
            ? h('button', { type: 'button', style: mutedStyle, onClick: copy }, copied ? '✓' : t('action.copy'))
            : null,
          h('button', {
            type: 'button',
            style: mutedStyle,
            'aria-label': t('action.close'),
            onClick: () => store.dismissItem(item.id),
          }, '×'),
        ),
        h('blockquote', { style: { ...quoteStyle, WebkitLineClamp: 2 } }, item.quote),
        body,
      )
    }

    /**
     * Frame-wide overlay: the composer plus the recent side conversations.
     * @returns the overlay element, or null when there is nothing to show.
     */
    function Overlay({ t }) {
      const state = useStore()
      const stackRef = React.useRef(null)
      const drag = useDrag(stackRef)
      const empty = state.composer === null && state.items.length === 0

      // A dragged stack keeps its own offset; growing content must not carry it
      // past the viewport edge, and a window resize must not strand it outside.
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
      }, [empty, state.items.length, state.composer?.key])

      if (empty) return null
      const placed = state.position === null ? card : {
        ...card,
        left: `${state.position.left}px`,
        top: `${state.position.top}px`,
        right: 'auto',
        bottom: 'auto',
      }
      return h('div', {
        ref: stackRef,
        style: placed,
        'data-aside-ask': 'stack',
        'data-aside-ask-version': VERSION,
      },
        state.items.map(item => h(Card, { key: item.id, item, t, drag })),
        h(Composer, { t, drag }),
      )
    }

    return {
      inject: ['slots', 'locale', 'uiConversation', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aside-ask: dictionaries')
        ctx.effect(() => ctx.uiConversation.interactions.register({
          id: 'aside-ask',
          onInteraction(request) {
            if (request.trigger !== 'contextmenu' || !request.hasSelection) return
            const text = request.readText()
            if (text === null || text.trim() === '') return
            const binding = ctx.sessions.binding(request.sessionId)
            if (binding === undefined) return
            request.preventDefault()
            store.open(request.sessionId, text.trim())
          },
        }), 'aside-ask: context menu interaction')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'aside-ask.stack', locale: NS,
        }, Overlay))
      },
    }
  },
})
