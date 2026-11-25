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
    }

    /** Frame-wide state shared by the gesture handler and the overlay card. */
    const store = {
      composer: null,
      items: [],
      listeners: new Set(),
      subscribe(listener) {
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      },
      notify() {
        for (const listener of [...store.listeners]) listener()
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

    const card = {
      position: 'fixed',
      right: '16px',
      bottom: '88px',
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
    function Composer({ t }) {
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
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('strong', { style: { fontSize: '12px', letterSpacing: '0.02em' } }, t('title')),
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
    function Card({ item, t }) {
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
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('strong', { style: { fontSize: '12px' } }, t('title')),
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
      const empty = state.composer === null && state.items.length === 0
      if (empty) return null
      return h('div', { style: card, 'data-aside-ask': 'stack' },
        state.items.map(item => h(Card, { key: item.id, item, t })),
        h(Composer, { t }),
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
