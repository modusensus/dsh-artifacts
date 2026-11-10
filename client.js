/**
 * dsh-artifacts — 「产物」左侧边栏面板（Client 半边）。
 *
 * 全局产物收藏夹 UI：全部/图片/文件/链接 四个 tab（带计数）、搜索、手动收藏
 * （链接 / 粘贴图片 / 上传文件）、卡片操作（打开/复制/删除）、图片灯箱。
 * 空态文案与设计稿一致。数据走 /api/dsh-artifacts。
 *
 * 注册：sidebar.panellist 图标入口（order 9，排在定时任务前）+ main keyed slot 面板体。
 * 注册 id 必须等于 loader entry 名（dsh-artifacts），否则 ModuleLoader 报
 * "loaded without registering dsh-artifacts"。
 */
window.__ModuleLoader__.load({
  id: '@modusensus/dsh-artifacts',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const PANEL_ID = 'dsh-artifacts'
    const API = '/api/dsh-artifacts'

    // ---- i18n（zh 主，en 兜底；宿主 locale 服务可选）----
    const DICT = {
      zh: {
        panel: '产物',
        tabAll: '全部', tabImage: '图片', tabVideo: '视频', tabFile: '文件', tabLink: '链接',
        search: '搜索产物…', refresh: '刷新', add: '收藏', addLink: '收藏链接', addPaste: '粘贴图片收藏',
        addFile: '上传文件收藏', pasteHint: '按 Ctrl+V 粘贴图片', save: '收藏', cancel: '取消',
        urlPlaceholder: 'https://…', titlePlaceholder: '标题（可选）', notePlaceholder: '备注（可选）',
        emptyTitle: '未找到产物',
        emptyText: '当会话生成图片、视频和文件输出时，它们会显示在这里。',
        emptyTextAdd: '也可以点右上角「收藏」手动收链接、图片或文件。',
        open: '打开', copy: '复制', download: '下载', remove: '删除', confirmRemove: '删除这条产物？',
        copied: '已复制', removed: '已删除', none: '没有匹配的产物',
        autoSource: '会话产出', manualSource: '手动收藏',
      },
      en: {
        panel: 'Artifacts',
        tabAll: 'All', tabImage: 'Images', tabVideo: 'Videos', tabFile: 'Files', tabLink: 'Links',
        search: 'Search artifacts…', refresh: 'Refresh', add: 'Save', addLink: 'Save link', addPaste: 'Paste image',
        addFile: 'Upload file', pasteHint: 'Press Ctrl+V to paste an image', save: 'Save', cancel: 'Cancel',
        urlPlaceholder: 'https://…', titlePlaceholder: 'Title (optional)', notePlaceholder: 'Note (optional)',
        emptyTitle: 'No artifacts yet',
        emptyText: 'Images, videos and files produced in sessions will show up here.',
        emptyTextAdd: 'You can also use "Save" to keep links, images or files.',
        open: 'Open', copy: 'Copy', download: 'Download', remove: 'Delete', confirmRemove: 'Delete this artifact?',
        copied: 'Copied', removed: 'Deleted', none: 'No matching artifacts',
        autoSource: 'from session', manualSource: 'manual',
      },
    }
    function activeLang(locale) {
      try {
        const code = locale?.getLocale?.().active ?? locale?.lang
        if (code === undefined || code === '') return 'zh'
        return code === 'zh' || code.startsWith('zh-') ? 'zh' : 'en'
      } catch { return 'zh' }
    }
    function buildTranslate(locale) {
      const lang = activeLang(locale)
      return (key) => DICT[lang]?.[key] ?? DICT.zh[key] ?? key
    }

    const h = React.createElement

    const CSS = [
      '.da-root{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;box-sizing:border-box}',
      '.da-root *{box-sizing:border-box}',
      '.da-topbar{display:flex;align-items:center;gap:10px;padding:14px 18px 0;flex-wrap:wrap}',
      '.da-tabs{display:flex;gap:2px;align-items:center;flex:1;min-width:0}',
      '.da-tab{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;padding:6px 10px;border-radius:10px;display:inline-flex;align-items:center;gap:6px;font-size:13px}',
      '.da-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.da-tab.on{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.da-tab .da-count{font-size:11px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
      '.da-actions{display:flex;align-items:center;gap:6px}',
      '.da-search{display:flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:0 10px;height:32px;background:var(--dsw-alias-bg-layer-1)}',
      '.da-search input{border:0;background:transparent;color:var(--dsw-alias-label-primary);outline:none;font:inherit;font-size:13px;width:150px}',
      '.da-search input::placeholder{color:var(--dsw-alias-label-caption)}',
      '.da-iconbtn{width:32px;height:32px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;padding:0;flex:none}',
      '.da-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.da-iconbtn[disabled]{opacity:.5;cursor:default}',
      '.da-addwrap{position:relative}',
      '.da-addbtn{height:32px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;border-radius:10px;padding:0 12px;display:inline-flex;align-items:center;gap:6px}',
      '.da-addbtn:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.da-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:60;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.2);padding:4px;min-width:180px}',
      '.da-menu button{display:flex;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;border-radius:8px;padding:8px 10px;align-items:center;gap:8px;text-align:left}',
      '.da-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.da-body{flex:1;min-height:0;overflow:auto;padding:14px 18px 24px;scrollbar-gutter:stable}',
      '.da-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}',
      '.da-card{position:relative;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.da-card:hover{border-color:var(--dsw-alias-border-l2)}',
      '.da-thumb{height:150px;background-size:cover;background-position:center;background-repeat:no-repeat;background-color:var(--dsw-alias-bg-base);cursor:pointer;display:block;width:100%;border:0;padding:0}',
      '.da-videothumb{height:150px;width:100%;object-fit:cover;background:var(--dsw-alias-bg-base);cursor:pointer;display:block;border:0;padding:0}',
      '.da-fileicon{height:110px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent);cursor:pointer;border:0;width:100%}',
      '.da-linkicon{height:74px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.da-meta{padding:9px 11px;display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}',
      '.da-name{font-size:13px;font-weight:500;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.da-name a{color:inherit;text-decoration:none}',
      '.da-name a:hover{color:var(--dsw-alias-brand-primary)}',
      '.da-sub{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.da-chip{flex:none;font-size:10px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.da-note{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.da-acts{display:flex;gap:4px;padding:0 9px 9px}',
      '.da-acts button{flex:1;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;border-radius:7px;padding:3px 0;cursor:pointer;font-family:inherit}',
      '.da-acts button:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.da-acts button.danger:hover{color:var(--dsw-alias-state-error-primary,#e5484d);border-color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.da-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:40px 20px}',
      '.da-empty .da-glyph{color:var(--dsw-alias-label-caption);margin-bottom:8px;opacity:.8}',
      '.da-empty h2{margin:0;font-size:15px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.da-empty p{margin:0;font-size:13px;line-height:1.7;max-width:420px}',
      '.da-form{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px;margin-bottom:14px;display:flex;flex-direction:column;gap:8px;max-width:560px}',
      '.da-form input[type=text],.da-form textarea{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;outline:none}',
      '.da-form input:focus,.da-form textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.da-form .da-row{display:flex;gap:8px;align-items:center}',
      '.da-form .da-row button{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;border-radius:8px;padding:5px 14px;cursor:pointer}',
      '.da-form .da-row button.primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.da-hint{font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.da-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:200;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:10px;padding:8px 16px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25)}',
      '.da-lightbox{position:fixed;inset:0;z-index:190;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:32px}',
      '.da-lightbox img{max-width:92vw;max-height:80vh;border-radius:10px;object-fit:contain}',
      '.da-lightbox video{max-width:92vw;max-height:76vh;border-radius:10px;background:#000}',
      '.da-lightbox .da-lbname{color:#fff;font-size:13px;max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.da-lightbox .da-lbacts{display:flex;gap:8px}',
      '.da-lightbox .da-lbacts button{border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.35);color:#fff;font:inherit;font-size:13px;border-radius:8px;padding:5px 14px;cursor:pointer}',
      '.da-filesize{font-variant-numeric:tabular-nums}',
    ].join('')

    // ---- API ----
    async function apiList(query) {
      const qs = query ? '&query=' + encodeURIComponent(query) : ''
      return (await fetch(API + '?list=1' + qs)).json()
    }
    async function apiPost(payload) {
      return (await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })).json()
    }

    // ---- helpers ----
    function fmtSize(n) {
      if (!n) return ''
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }
    function fmtDate(iso) {
      try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return ''
        const now = Date.now()
        const diff = (now - d.getTime()) / 60000
        if (diff < 1) return '刚刚'
        if (diff < 60) return Math.floor(diff) + ' 分钟前'
        if (diff < 60 * 24) return Math.floor(diff / 60) + ' 小时前'
        return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
      } catch { return '' }
    }
    function readClipboardImage() {
      return new Promise((resolve) => {
        try {
          navigator.clipboard.read().then(async (items) => {
            for (const item of items) {
              const type = item.types.find((t) => t.startsWith('image/'))
              if (type) {
                const blob = await item.getType(type)
                resolve({ blob, mime: type, name: '粘贴图片.' + (type.split('/')[1] || 'png') })
                return
              }
            }
            resolve(null)
          }).catch(() => resolve(null))
        } catch { resolve(null) }
      })
    }
    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
      })
    }

    // ---- 图标 ----
    function glyph(kind, size = 22) {
      const common = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      }
      if (kind === 'file') {
        return h('svg', common,
          h('path', { d: 'M6 3.5h8L19 8v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1-1.5z' }),
          h('path', { d: 'M13.5 3.5V8H19M8.5 13h7M8.5 16.5h5' }))
      }
      if (kind === 'link') {
        return h('svg', common,
          h('path', { d: 'M10.5 13.5a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.3 1.3' }),
          h('path', { d: 'M13.5 10.5a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.3-1.3' }))
      }
      if (kind === 'image') {
        return h('svg', common,
          h('rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2 }),
          h('circle', { cx: 9, cy: 10, r: 1.8 }),
          h('path', { d: 'M4.5 17.5l4.8-4.8a1.5 1.5 0 0 1 2.1 0l6.1 6.1M15 15.2l1.6-1.6a1.5 1.5 0 0 1 2.1 0l1.8 1.8' }))
      }
      if (kind === 'video') {
        return h('svg', common,
          h('rect', { x: 3.5, y: 5.5, width: 17, height: 13, rx: 2 }),
          h('path', { d: 'M10 9.2v5.6l4.8-2.8z', fill: 'currentColor', stroke: 'none' }),
          h('path', { d: 'M7.5 5.5V3.8M16.5 5.5V3.8M7.5 20.2v-1.7M16.5 20.2v-1.7' }))
      }
      if (kind === 'search') {
        return h('svg', common,
          h('circle', { cx: 11, cy: 11, r: 6.5 }),
          h('path', { d: 'M16 16l4.5 4.5' }))
      }
      if (kind === 'refresh') {
        return h('svg', common,
          h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
          h('path', { d: 'M20 4v4.5h-4.5' }))
      }
      if (kind === 'plus') {
        return h('svg', common,
          h('path', { d: 'M12 5v14M5 12h14' }))
      }
      if (kind === 'chevron') {
        return h('svg', common,
          h('path', { d: 'M6 9l6 6 6-6' }))
      }
      // box（侧边栏入口图标：收纳盒）
      return h('svg', common,
        h('path', { d: 'M4 8.2 12 4l8 4.2v7.6L12 20l-8-4.2z' }),
        h('path', { d: 'M4 8.2 12 12.4l8-4.2M12 12.4V20' }))
    }

    function PanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return glyph('box', size)
    }

    // 宿主 locale 服务注入后由 apply 写入；PanelView 渲染时才读取
    const tRef = { current: (key) => DICT.zh[key] ?? key }

    // ---- 组件 ----
    function Card({ item, t, onOpenImage, onToast }) {
      const doOpen = () => {
        if (item.kind === 'link') window.open(item.url, '_blank', 'noopener')
        else if (item.kind === 'image' || item.kind === 'video') onOpenImage(item)
        else window.open(item.url, '_blank', 'noopener')
      }
      const doCopy = async () => {
        try {
          await navigator.clipboard.writeText(item.kind === 'link' ? item.url : (item.originPath || item.url))
          onToast(t('copied'))
        } catch { /* 无权限就算了 */ }
      }
      const doRemove = async () => {
        if (!window.confirm(t('confirmRemove'))) return
        const r = await apiPost({ action: 'remove', id: item.id })
        if (r.ok) onToast(t('removed'))
        window.dispatchEvent(new CustomEvent('dsh-artifacts:changed'))
      }
      const thumbStyle = item.kind === 'image' ? { backgroundImage: 'url("' + item.url + '")' } : undefined
      return h('div', { className: 'da-card' },
        item.kind === 'image'
          ? h('button', { className: 'da-thumb', style: thumbStyle, onClick: doOpen, 'aria-label': item.name, title: item.name })
          : item.kind === 'video'
            ? h('video', { className: 'da-videothumb', src: item.url, preload: 'metadata', muted: true, playsInline: true, onClick: doOpen, title: item.name })
            : item.kind === 'file'
              ? h('button', { className: 'da-fileicon', onClick: doOpen, title: item.name }, glyph('file', 30))
              : h('div', { className: 'da-linkicon' }, glyph('link', 26)),
        h('div', { className: 'da-meta' },
          h('div', { className: 'da-name', title: item.name },
            item.kind === 'link'
              ? h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.name)
              : item.name),
          item.note ? h('div', { className: 'da-note', title: item.note }, item.note) : null,
          h('div', { className: 'da-sub' },
            h('span', { className: 'da-chip' },
              item.kind === 'image' ? t('tabImage')
                : item.kind === 'video' ? t('tabVideo')
                  : item.kind === 'file' ? t('tabFile')
                    : (item.host || t('tabLink'))),
            item.size ? h('span', { className: 'da-filesize' }, fmtSize(item.size)) : null,
            item.source ? h('span', null, item.source) : null,
            h('span', null, fmtDate(item.addedAt)))),
        h('div', { className: 'da-acts' },
          h('button', { type: 'button', onClick: doOpen }, t('open')),
          h('button', { type: 'button', onClick: doCopy }, t('copy')),
          (item.kind === 'file' || item.kind === 'video') ? h('button', { type: 'button', onClick: () => window.open(item.url + '?download=1', '_blank', 'noopener') }, t('download')) : null,
          h('button', { type: 'button', className: 'danger', onClick: doRemove }, t('remove'))))
    }

    function Lightbox({ item, t, onClose }) {
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', { className: 'da-lightbox', onClick: onClose },
        item.kind === 'video'
          ? h('video', { src: item.url, controls: true, autoPlay: true, style: { maxWidth: '92vw', maxHeight: '76vh' }, onClick: (e) => e.stopPropagation() })
          : h('img', { src: item.url, alt: item.name, onClick: (e) => e.stopPropagation() }),
        h('div', { className: 'da-lbname' }, item.name),
        h('div', { className: 'da-lbacts', onClick: (e) => e.stopPropagation() },
          h('button', { type: 'button', onClick: () => window.open(item.url + '?download=1', '_blank', 'noopener') }, t('download')),
          h('button', { type: 'button', onClick: onClose }, t('cancel'))))
    }

    function AddLinkForm({ t, onDone, onToast }) {
      const [url, setUrl] = React.useState('')
      const [title, setTitle] = React.useState('')
      const [note, setNote] = React.useState('')
      const submit = async () => {
        if (!url.trim()) return
        const r = await apiPost({ action: 'addLink', url: url.trim(), title: title.trim(), note: note.trim() })
        onToast(r.message || (r.ok ? t('save') + ' OK' : 'failed'))
        if (r.ok) {
          setUrl(''); setTitle(''); setNote('')
          onDone()
          window.dispatchEvent(new CustomEvent('dsh-artifacts:changed'))
        }
      }
      return h('div', { className: 'da-form' },
        h('div', { className: 'da-row' },
          h('input', { type: 'text', placeholder: t('urlPlaceholder'), value: url, autoFocus: true, onChange: (e) => setUrl(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') void submit() } }),
          h('button', { type: 'button', className: 'primary', onClick: () => void submit() }, t('save'))),
        h('div', { className: 'da-row' },
          h('input', { type: 'text', placeholder: t('titlePlaceholder'), value: title, onChange: (e) => setTitle(e.target.value), style: { flex: 1 } }),
          h('button', { type: 'button', onClick: onDone }, t('cancel'))),
        h('textarea', { placeholder: t('notePlaceholder'), value: note, rows: 2, onChange: (e) => setNote(e.target.value) }))
    }

    function PanelView() {
      const t = tRef.current
      const [tab, setTab] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const [items, setItems] = React.useState(null)
      const [counts, setCounts] = React.useState({ all: 0, image: 0, video: 0, file: 0, link: 0 })
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [showLinkForm, setShowLinkForm] = React.useState(false)
      const [lightbox, setLightbox] = React.useState(null)
      const [toast, setToast] = React.useState('')
      const fileInputRef = React.useRef(null)
      const imageInputRef = React.useRef(null)
      const toastTimer = React.useRef(null)

      const showToast = React.useCallback((msg) => {
        setToast(String(msg || ''))
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 2400)
      }, [])

      const reload = React.useCallback(async (q) => {
        try {
          const r = await apiList(q)
          if (r.ok) {
            setItems(r.items)
            setCounts(r.counts || { all: (r.items || []).length, image: 0, video: 0, file: 0, link: 0 })
          }
        } catch { /* 宿主未就绪时静默，下次刷新再试 */ }
      }, [])

      React.useEffect(() => {
        void reload('')
        const onChanged = () => { void reload(query) }
        window.addEventListener('dsh-artifacts:changed', onChanged)
        return () => window.removeEventListener('dsh-artifacts:changed', onChanged)
      }, [reload])

      React.useEffect(() => {
        const timer = setTimeout(() => { void reload(query) }, query ? 250 : 0)
        return () => clearTimeout(timer)
      }, [query, reload])

      // 粘贴图片直接收藏
      React.useEffect(() => {
        const onPaste = async (e) => {
          const files = Array.from(e.clipboardData?.files || [])
          const img = files.find((f) => f.type.startsWith('image/'))
          if (!img) return
          const data = await fileToBase64(img)
          const r = await apiPost({ action: 'addBase64', data, mime: img.type, name: img.name || '粘贴图片.png', source: t('manualSource') })
          showToast(r.message)
          if (r.ok) { window.dispatchEvent(new CustomEvent('dsh-artifacts:changed')); void reload(query) }
        }
        window.addEventListener('paste', onPaste)
        return () => window.removeEventListener('paste', onPaste)
      }, [query, reload, showToast, t])

      const pickAndSend = async (fileList) => {
        for (const file of Array.from(fileList || [])) {
          try {
            const data = await fileToBase64(file)
            const r = await apiPost({ action: 'addBase64', data, mime: file.type, name: file.name, source: t('manualSource') })
            showToast(r.message)
          } catch (error) {
            showToast(String(error && error.message || error))
          }
        }
        window.dispatchEvent(new CustomEvent('dsh-artifacts:changed'))
        void reload(query)
      }

      const shown = (items || []).filter((it) => tab === 'all' ? true : it.kind === tab)
      const empty = (items || []).length === 0
      const noneInTab = !empty && shown.length === 0

      return h('div', { className: 'da-root' },
        h('div', { className: 'da-topbar' },
          h('nav', { className: 'da-tabs', 'aria-label': t('panel') },
            [['all', t('tabAll')], ['image', t('tabImage')], ['video', t('tabVideo')], ['file', t('tabFile')], ['link', t('tabLink')]].map(([id, label]) =>
              h('button', {
                key: id, type: 'button', className: 'da-tab' + (tab === id ? ' on' : ''),
                'aria-current': tab === id ? 'page' : undefined,
                onClick: () => setTab(id),
              },
                label, h('span', { className: 'da-count' }, String(counts[id] ?? 0))))),
          h('div', { className: 'da-actions' },
            h('label', { className: 'da-search' },
              glyph('search', 14),
              h('input', { type: 'text', placeholder: t('search'), value: query, onChange: (e) => setQuery(e.target.value) })),
            h('button', { type: 'button', className: 'da-iconbtn', title: t('refresh'), onClick: () => void reload(query) }, glyph('refresh', 15)),
            h('div', { className: 'da-addwrap' },
              h('button', { type: 'button', className: 'da-addbtn', onClick: () => setMenuOpen(!menuOpen) }, glyph('plus', 14), t('add'), glyph('chevron', 12)),
              menuOpen ? h('div', { className: 'da-menu', onMouseLeave: () => setMenuOpen(false) },
                h('button', { type: 'button', onClick: () => { setMenuOpen(false); setShowLinkForm(true) } }, glyph('link', 15), t('addLink')),
                h('button', { type: 'button', onClick: () => { setMenuOpen(false); imageInputRef.current?.click() } }, glyph('image', 15), t('addPaste')),
                h('button', { type: 'button', onClick: () => { setMenuOpen(false); fileInputRef.current?.click() } }, glyph('file', 15), t('addFile'))) : null))),
        h('input', { ref: imageInputRef, type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onChange: (e) => { void pickAndSend(e.target.files); e.target.value = '' } }),
        h('input', { ref: fileInputRef, type: 'file', multiple: true, style: { display: 'none' }, onChange: (e) => { void pickAndSend(e.target.files); e.target.value = '' } }),
        h('div', { className: 'da-body' },
          showLinkForm ? h(AddLinkForm, { t, onDone: () => setShowLinkForm(false), onToast: showToast }) : null,
          empty
            ? h('div', { className: 'da-empty' },
                h('div', { className: 'da-glyph' }, glyph('box', 44)),
                h('h2', null, t('emptyTitle')),
                h('p', null, t('emptyText')),
                h('p', null, t('emptyTextAdd')))
            : noneInTab
              ? h('div', { className: 'da-empty' }, h('h2', null, t('none')))
              : h('div', { className: 'da-grid' },
                  shown.map((item) => h(Card, { key: item.id, item, t, onOpenImage: setLightbox, onToast: showToast })))),
        lightbox ? h(Lightbox, { item: lightbox, t, onClose: () => setLightbox(null) }) : null,
        toast ? h('div', { className: 'da-toast' }, toast) : null)
    }

    // 宿主 locale 服务经 dsh.client.inject 注入后写入 tRef
    const apply = (ctx) => {
      const slots = ctx.get?.('slots')
      if (slots === undefined || typeof slots.register !== 'function') return
      const locale = ctx.get?.('locale')
      tRef.current = buildTranslate(locale)

      const style = document.createElement('style')
      style.setAttribute('data-dsh-artifacts', '')
      style.textContent = CSS
      document.head.appendChild(style)

      const disposers = []
      disposers.push(slots.inject('main', () => {
        const disposeMain = slots.register({ name: 'main', key: PANEL_ID }, PanelView)
        const disposeEntry = slots.inject('sidebar.panellist', () => slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 9, label: () => tRef.current('panel') },
          PanelIcon,
        ))
        return [disposeMain, disposeEntry]
      }))

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) {
            try { dispose() } catch { /* 已卸载 */ }
          }
          style.remove()
        }, 'dsh-artifacts:client')
      }
    }

    module.exports = { apply }
    return module.exports
  },
})
