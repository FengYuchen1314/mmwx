import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { api, asList } from './api'

type AnyRecord = Record<string, any>

export type RuleTemplateCatalog = {
  templates: string[]
  owners: Record<string, string>
  username: string
  isAdmin: boolean
}

type V3TemplateInfo = {
  name: string
  filename: string
  type: string
  variables?: Record<string, string>
}

const emptyCatalog: RuleTemplateCatalog = { templates: [], owners: {}, username: '', isAdmin: false }
const text = (value: unknown, fallback = '') => value === null || value === undefined ? fallback : String(value)
const messageOf = (reason: unknown, fallback = '操作失败') => reason instanceof Error ? reason.message : fallback
const isClashTemplate = (filename: string) => /\.ya?ml$/i.test(filename)
const isSurgeTemplate = (filename: string) => /\.conf$/i.test(filename)

export async function loadRuleTemplateCatalog(): Promise<RuleTemplateCatalog> {
  const value = await api<AnyRecord>('/api/admin/rule-templates')
  const templates = asList<string>(value.templates).map(String)
  const owners = value.owners && typeof value.owners === 'object' && !Array.isArray(value.owners)
    ? Object.fromEntries(Object.entries(value.owners).map(([key, owner]) => [key, text(owner)]))
    : {}
  return {
    templates,
    owners,
    username: text(value.username),
    isAdmin: value.is_admin === true,
  }
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`pixel-card ${className}`}>{children}</section>
}

function ActionButton({ children, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button {...props} className={`btn ${variant} ${props.className ?? ''}`}>{children}</button>
}

function Feedback({ message, error = false }: { message: string; error?: boolean }) {
  return message ? <div className={`notice ${error ? 'error' : ''}`}>{message}</div> : null
}

function Loading() {
  return <div className="loading"><span className="operation-spinner"/>正在加载…</div>
}

function Empty({ title, description }: { title: string; description: string }) {
  return <div className="empty"><strong>{title}</strong><p>{description}</p></div>
}

function Dialog({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal modal-wide" role="dialog" aria-modal="true">
      <div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><ActionButton type="button" variant="ghost" onClick={onClose} aria-label="关闭">×</ActionButton></div>
      {children}
    </div>
  </div>
}

export function RuleTemplatesPanel({ isAdmin, currentUsername }: { isAdmin: boolean; currentUsername: string }) {
  const [catalog, setCatalog] = useState<RuleTemplateCatalog>(emptyCatalog)
  const [v3Templates, setV3Templates] = useState<V3TemplateInfo[]>([])
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [userDefault, setUserDefault] = useState('')
  const [globalDefaults, setGlobalDefaults] = useState({ clash: '', surge: '' })
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [userDefaultLoaded, setUserDefaultLoaded] = useState(false)
  const [visibilityLoaded, setVisibilityLoaded] = useState(false)
  const [globalDefaultsLoaded, setGlobalDefaultsLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState({ message: '', error: false })
  const [file, setFile] = useState<File | null>(null)
  const [editing, setEditing] = useState('')
  const [section, setSection] = useState<'files' | 'v3'>('files')

  const load = useCallback(async () => {
    setLoading(true)
    setCatalogLoaded(false)
    setUserDefaultLoaded(false)
    setVisibilityLoaded(false)
    setGlobalDefaultsLoaded(false)
    setFeedback({ message: '', error: false })
    const requests: Promise<unknown>[] = [
      loadRuleTemplateCatalog(),
      api<AnyRecord>('/api/admin/template-v3'),
      api<AnyRecord>('/api/user/default-template'),
    ]
    if (isAdmin) {
      requests.push(api<AnyRecord>('/api/admin/rule-templates/visibility'))
      requests.push(api<AnyRecord>('/api/admin/system-settings/default-template'))
    }
    const results = await Promise.allSettled(requests)
    const failures: string[] = []
    if (results[0].status === 'fulfilled') { setCatalog(results[0].value as RuleTemplateCatalog); setCatalogLoaded(true) }
    else failures.push(messageOf(results[0].reason, '模板目录加载失败'))
    if (results[1].status === 'fulfilled') setV3Templates(asList<V3TemplateInfo>((results[1].value as AnyRecord).templates))
    else failures.push(messageOf(results[1].reason, 'V3 模板信息加载失败'))
    if (results[2].status === 'fulfilled') { setUserDefault(text((results[2].value as AnyRecord).default_template_filename)); setUserDefaultLoaded(true) }
    else failures.push(messageOf(results[2].reason, '个人默认模板加载失败'))
    if (isAdmin && results[3]) {
      if (results[3].status === 'fulfilled') { setHidden(new Set(asList<string>((results[3].value as AnyRecord).hidden).map(String))); setVisibilityLoaded(true) }
      else failures.push(messageOf(results[3].reason, '模板可见性加载失败'))
    }
    if (isAdmin && results[4]) {
      if (results[4].status === 'fulfilled') {
        const value = results[4].value as AnyRecord
        setGlobalDefaults({ clash: text(value.default_template_filename), surge: text(value.default_surge_template_filename) })
        setGlobalDefaultsLoaded(true)
      } else failures.push(messageOf(results[4].reason, '全局默认模板加载失败'))
    }
    if (failures.length) setFeedback({ message: failures.join('；'), error: true })
    setLoading(false)
  }, [isAdmin])

  useEffect(() => { void load() }, [load])

  const ownerName = currentUsername || catalog.username
  const ownedClashTemplates = catalog.templates.filter((name) => /\.yaml$/i.test(name) && catalog.owners[name] === ownerName)
  const clashTemplates = catalog.templates.filter(isClashTemplate)
  const surgeTemplates = catalog.templates.filter(isSurgeTemplate)

  const upload = async (event: FormEvent) => {
    event.preventDefault()
    if (!file) { setFeedback({ message: '请先选择 .yaml、.yml 或 .conf 模板文件。', error: true }); return }
    setBusy('upload'); setFeedback({ message: '', error: false })
    try {
      const body = new FormData()
      body.append('template', file)
      await api('/api/admin/rule-templates/upload', { method: 'POST', body })
      setFile(null)
      const input = document.getElementById('rule-template-upload') as HTMLInputElement | null
      if (input) input.value = ''
      setFeedback({ message: `模板 ${file.name} 已上传。`, error: false })
      await load()
    } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
    finally { setBusy('') }
  }

  const remove = async (filename: string) => {
    if (!window.confirm(`确定永久删除模板文件“${filename}”吗？\n\n引用它的订阅或默认模板需要改用其他文件。`)) return
    setBusy(`delete:${filename}`); setFeedback({ message: '', error: false })
    try {
      await api(`/api/admin/rule-templates/${encodeURIComponent(filename)}`, { method: 'DELETE' })
      setFeedback({ message: `模板 ${filename} 已删除。`, error: false })
      await load()
    } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
    finally { setBusy('') }
  }

  const saveVisibility = async () => {
    if (!catalogLoaded || !visibilityLoaded) { setFeedback({ message: '模板目录或可见性配置尚未完整载入，已阻止覆盖。请刷新后重试。', error: true }); return }
    if (!window.confirm('确定保存所有模板对普通用户的公开范围吗？')) return
    setBusy('visibility'); setFeedback({ message: '', error: false })
    try {
      await api('/api/admin/rule-templates/visibility', { method: 'PUT', body: JSON.stringify({ hidden: [...hidden] }) })
      setFeedback({ message: '模板公开范围已保存。', error: false })
    } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
    finally { setBusy('') }
  }

  const saveUserDefault = async () => {
    if (!catalogLoaded || !userDefaultLoaded) { setFeedback({ message: '模板目录或个人默认值尚未完整载入，已阻止保存。请刷新后重试。', error: true }); return }
    setBusy('user-default'); setFeedback({ message: '', error: false })
    try {
      await api('/api/user/default-template', { method: 'PUT', body: JSON.stringify({ default_template_filename: userDefault }) })
      setFeedback({ message: userDefault ? '个人默认模板已更新。' : '个人默认模板已清除。', error: false })
    } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
    finally { setBusy('') }
  }

  const saveGlobalDefaults = async () => {
    if (!catalogLoaded || !globalDefaultsLoaded) { setFeedback({ message: '模板目录或系统默认值尚未完整载入，已阻止保存。请刷新后重试。', error: true }); return }
    setBusy('global-default'); setFeedback({ message: '', error: false })
    try {
      await api('/api/admin/system-settings/default-template', { method: 'PUT', body: JSON.stringify({ default_template_filename: globalDefaults.clash, default_surge_template_filename: globalDefaults.surge }) })
      setFeedback({ message: '系统默认 Clash 与 Surge 模板已更新。', error: false })
    } catch (reason) { setFeedback({ message: messageOf(reason), error: true }) }
    finally { setBusy('') }
  }

  return <>
    <div className="tabs log-tabs">
      <button className={section === 'files' ? 'active' : ''} onClick={() => setSection('files')}>模板文件</button>
      <button className={section === 'v3' ? 'active' : ''} onClick={() => setSection('v3')}>V3 工作台</button>
    </div>
    <Feedback {...feedback}/>
    {loading && !catalogLoaded ? <Panel><Loading/></Panel> : section === 'files' ? <div className="stack-form">
      <Panel>
        <div className="card-head"><div><h2>上传模板文件</h2><p>Clash 使用 .yaml / .yml，Surge 使用 .conf；单个文件不超过 2 MB。</p></div></div>
        <form className="aligned-action" onSubmit={upload}>
          <label><span>选择模板</span><input id="rule-template-upload" type="file" accept=".yaml,.yml,.conf" onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] ?? null)}/></label>
          <ActionButton type="submit" disabled={busy === 'upload'}>{busy === 'upload' ? '上传中…' : '上传'}</ActionButton>
        </form>
      </Panel>
      <div className="two-column">
        <Panel>
          <div className="card-head"><div><h2>个人默认模板</h2><p>后端只允许选择本人拥有的 .yaml 文件；公共模板不能设为个人默认。</p></div></div>
          <div className="stack-form"><label><span>默认 Clash 模板</span><select disabled={!userDefaultLoaded} value={userDefault} onChange={(event) => setUserDefault(event.target.value)}><option value="">跟随套餐 / 系统默认</option>{userDefault && !ownedClashTemplates.includes(userDefault) && <option value={userDefault}>{userDefault}（当前值不可再选）</option>}{ownedClashTemplates.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><ActionButton type="button" disabled={!catalogLoaded || !userDefaultLoaded || busy === 'user-default'} onClick={() => void saveUserDefault()}>{busy === 'user-default' ? '保存中…' : '保存个人默认'}</ActionButton></div>
        </Panel>
        {isAdmin ? <Panel>
          <div className="card-head"><div><h2>系统默认模板</h2><p>套餐与订阅未单独绑定模板时，分别按客户端类型回落到这里。</p></div></div>
          <div className="stack-form"><label><span>Clash / Mihomo 默认</span><select disabled={!globalDefaultsLoaded} value={globalDefaults.clash} onChange={(event) => setGlobalDefaults((old) => ({ ...old, clash: event.target.value }))}><option value="">不设置</option>{globalDefaults.clash && !clashTemplates.includes(globalDefaults.clash) && <option value={globalDefaults.clash}>{globalDefaults.clash}（文件不存在）</option>}{clashTemplates.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label><span>Surge 默认</span><select disabled={!globalDefaultsLoaded} value={globalDefaults.surge} onChange={(event) => setGlobalDefaults((old) => ({ ...old, surge: event.target.value }))}><option value="">不设置</option>{globalDefaults.surge && !surgeTemplates.includes(globalDefaults.surge) && <option value={globalDefaults.surge}>{globalDefaults.surge}（文件不存在）</option>}{surgeTemplates.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><ActionButton type="button" disabled={!catalogLoaded || !globalDefaultsLoaded || busy === 'global-default'} onClick={() => void saveGlobalDefaults()}>{busy === 'global-default' ? '保存中…' : '保存系统默认'}</ActionButton></div>
        </Panel> : <Panel><div className="card-head"><div><h2>文件权限</h2><p>你可以上传、编辑和删除自己的模板；管理员公开的模板可使用但不可改动。</p></div></div><div className="form-note">模板上传受账户配额与全局 200 个文件上限约束。订阅绑定时，后端仍会重新校验可见性和所有权。</div></Panel>}
      </div>
      <Panel className="table-card">
        <div className="card-head"><div><h2>模板文件 {catalog.templates.length}</h2><p>{isAdmin ? '勾选“普通用户可见”可统一控制内置模板与用户模板的公开范围。' : '共享文件为只读；你自己的文件可以编辑、重命名或删除。'}</p></div><ActionButton type="button" variant="secondary" disabled={loading} onClick={() => void load()}>刷新</ActionButton></div>
        {catalog.templates.length ? <div className="library-grid">{catalog.templates.map((filename) => {
          const owner = catalog.owners[filename] ?? ''
          const canManage = isAdmin || (owner !== '' && owner === ownerName)
          const visible = !hidden.has(filename)
          const info = v3Templates.find((item) => item.filename === filename)
          return <article key={filename}><span>{isSurgeTemplate(filename) ? 'S' : 'V3'}</span><div><strong>{filename}</strong><small>{isSurgeTemplate(filename) ? 'Surge' : 'Clash / Mihomo'} · {owner ? owner === '__shared__' ? '公开共享' : owner === ownerName ? '我的模板' : `所有者 ${owner}` : '内置模板'}{info?.variables && Object.keys(info.variables).length ? ` · ${Object.keys(info.variables).length} 个变量` : ''}</small>{isAdmin && <label className="inline-check"><input type="checkbox" disabled={!visibilityLoaded} checked={visible} onChange={(event) => setHidden((old) => { const next = new Set(old); if (event.target.checked) next.delete(filename); else next.add(filename); return next })}/> 普通用户可见</label>}</div>{canManage && <div className="row-actions"><ActionButton type="button" variant="ghost" onClick={() => setEditing(filename)}>编辑</ActionButton><ActionButton type="button" variant="danger" disabled={busy === `delete:${filename}`} onClick={() => void remove(filename)}>删除</ActionButton></div>}</article>
        })}</div> : <Empty title="暂无模板文件" description="上传模板文件后可绑定到订阅、套餐或默认模板。"/>}
        {isAdmin && catalog.templates.length > 0 && <div className="modal-actions"><ActionButton type="button" disabled={!catalogLoaded || !visibilityLoaded || busy === 'visibility'} onClick={() => void saveVisibility()}>{busy === 'visibility' ? '保存中…' : '保存公开范围'}</ActionButton></div>}
      </Panel>
    </div> : <TemplateV3Workbench catalog={catalog} metadata={v3Templates}/>}
    {editing ? <RuleTemplateEditor filename={editing} onClose={() => setEditing('')} onChanged={async (message) => { setEditing(''); setFeedback({ message, error: false }); await load() }}/> : null}
  </>
}

function RuleTemplateEditor({ filename, onClose, onChanged }: { filename: string; onClose: () => void; onChanged: (message: string) => Promise<void> }) {
  const [content, setContent] = useState('')
  const [newName, setNewName] = useState(filename)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState('load')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setBusy('load'); setError('')
    try {
      const value = await api<AnyRecord>(`/api/admin/rule-templates/${encodeURIComponent(filename)}`)
      setContent(text(value.content)); setLoaded(true)
    } catch (reason) { setError(messageOf(reason)); setLoaded(false) }
    finally { setBusy('') }
  }, [filename])
  useEffect(() => { void load() }, [load])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!loaded) { setError('模板内容尚未成功载入，已阻止覆盖文件。'); return }
    setBusy('save'); setError('')
    try {
      await api(`/api/admin/rule-templates/${encodeURIComponent(filename)}`, { method: 'PUT', body: JSON.stringify({ content }) })
      await onChanged(`模板 ${filename} 已保存。`)
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy('') }
  }

  const rename = async () => {
    const target = newName.trim()
    if (!target || target === filename) return
    if (!window.confirm(`确定把“${filename}”重命名为“${target}”吗？\n\n已有订阅和默认模板中的旧文件名不会自动改写；尚未保存的内容编辑也会丢失。`)) return
    setBusy('rename'); setError('')
    try {
      const value = await api<AnyRecord>('/api/admin/rule-templates/rename', { method: 'POST', body: JSON.stringify({ old_name: filename, new_name: target }) })
      await onChanged(`模板已重命名为 ${text(value.filename, target)}。`)
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy('') }
  }

  return <Dialog title={`编辑模板 · ${filename}`} description="保存内容与重命名是两个独立操作；失败时不会覆盖当前编辑内容。" onClose={onClose}>
    {busy === 'load' ? <Loading/> : <form className="modal-form" onSubmit={save}>
      <div className="field-row"><label><span>文件名</span><input value={newName} onChange={(event) => setNewName(event.target.value)}/></label><div className="aligned-action"><ActionButton type="button" variant="secondary" disabled={busy !== '' || newName.trim() === filename} onClick={() => void rename()}>重命名</ActionButton></div></div>
      <label><span>{isSurgeTemplate(filename) ? 'Surge 配置内容' : 'V3 YAML 内容'}</span><textarea className="code-editor" rows={24} spellCheck={false} value={content} onChange={(event) => setContent(event.target.value)}/></label>
      <Feedback message={error} error/>
      <div className="modal-actions"><ActionButton type="button" variant="secondary" onClick={onClose}>取消</ActionButton><ActionButton type="submit" disabled={!loaded || busy !== ''}>{busy === 'save' ? '保存中…' : '保存内容'}</ActionButton></div>
    </form>}
  </Dialog>
}

function parseProxies(value: string): AnyRecord[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('代理节点必须是 JSON 对象数组。')
  return parsed as AnyRecord[]
}

function TemplateV3Workbench({ catalog, metadata }: { catalog: RuleTemplateCatalog; metadata: V3TemplateInfo[] }) {
  const clashTemplates = useMemo(() => catalog.templates.filter(isClashTemplate), [catalog.templates])
  const [mode, setMode] = useState<'render' | 'convert' | 'analyze'>('render')
  const [templateName, setTemplateName] = useState('')
  const [templateContent, setTemplateContent] = useState('')
  const [proxiesText, setProxiesText] = useState('[\n  {\n    "name": "预览节点",\n    "type": "ss",\n    "server": "127.0.0.1",\n    "port": 443,\n    "cipher": "aes-128-gcm",\n    "password": "preview"\n  }\n]')
  const [tagsText, setTagsText] = useState('')
  const [v2Content, setV2Content] = useState('')
  const [subscriptionContent, setSubscriptionContent] = useState('')
  const [output, setOutput] = useState('')
  const [analysis, setAnalysis] = useState('')
  const [filters, setFilters] = useState<AnyRecord>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!templateName && clashTemplates[0]) setTemplateName(clashTemplates[0])
  }, [clashTemplates, templateName])
  useEffect(() => {
    api<AnyRecord>('/api/admin/template-v3/region-filters').then(setFilters).catch(() => undefined)
  }, [])

  const loadContent = async () => {
    if (!templateName) { setError('请先选择模板文件。'); return }
    setBusy('load'); setError('')
    try {
      const value = await api<AnyRecord>(`/api/admin/rule-templates/${encodeURIComponent(templateName)}`)
      setTemplateContent(text(value.content))
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy('') }
  }

  const render = async (action: 'process' | 'preview' | 'tags') => {
    setBusy(action); setError('')
    try {
      let value: AnyRecord
      if (action === 'tags') {
        if (!templateName) throw new Error('请先选择模板文件。')
        const selectedTags = tagsText.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean)
        value = await api<AnyRecord>('/api/admin/template-v3/preview-with-tags', { method: 'POST', body: JSON.stringify({ template_filename: templateName, selected_tags: selectedTags }) })
      } else {
        const proxies = parseProxies(proxiesText)
        if (action === 'process') {
          if (!templateName) throw new Error('请先选择模板文件。')
          value = await api<AnyRecord>('/api/admin/template-v3/process', { method: 'POST', body: JSON.stringify({ template_name: templateName, proxies }) })
        } else {
          if (!templateContent.trim()) throw new Error('请先载入或填写模板内容。')
          value = await api<AnyRecord>('/api/admin/template-v3/preview', { method: 'POST', body: JSON.stringify({ template_content: templateContent, proxies }) })
        }
      }
      setOutput(text(value.content, JSON.stringify(value, null, 2)))
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy('') }
  }

  const convert = async () => {
    if (!v2Content.trim()) { setError('请粘贴 V2 / ACL4SSR 模板内容。'); return }
    setBusy('convert'); setError('')
    try {
      const value = await api<AnyRecord>('/api/admin/template-v3/convert-v2', { method: 'POST', body: JSON.stringify({ content: v2Content }) })
      setOutput(JSON.stringify(value, null, 2))
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy('') }
  }

  const analyzeSubscription = async () => {
    if (!subscriptionContent.trim()) { setError('请粘贴订阅内容。'); return }
    setBusy('analyze'); setError('')
    try {
      const value = await api<AnyRecord>('/api/admin/template-v3/analyze-subscription', { method: 'POST', body: JSON.stringify({ subscription_content: subscriptionContent }) })
      setOutput(text(value.template_content))
      setAnalysis(JSON.stringify(value.analysis ?? {}, null, 2))
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy('') }
  }

  const selectedMetadata = metadata.find((item) => item.filename === templateName)
  return <div className="stack-form">
    <Panel>
      <div className="card-head"><div><h2>Template V3 工作台</h2><p>所有入口都使用后端真实处理器；这里只预览和分析，不会写入模板文件。</p></div></div>
      <div className="tabs log-tabs"><button className={mode === 'render' ? 'active' : ''} onClick={() => setMode('render')}>渲染预览</button><button className={mode === 'convert' ? 'active' : ''} onClick={() => setMode('convert')}>V2 转 V3</button><button className={mode === 'analyze' ? 'active' : ''} onClick={() => setMode('analyze')}>分析订阅</button></div>
      <Feedback message={error} error/>
      {mode === 'render' ? <div className="stack-form">
        <div className="field-row"><label><span>已保存的 Clash 模板</span><select value={templateName} onChange={(event) => setTemplateName(event.target.value)}><option value="">请选择</option>{clashTemplates.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><div className="aligned-action"><ActionButton type="button" variant="secondary" disabled={busy !== '' || !templateName} onClick={() => void loadContent()}>{busy === 'load' ? '载入中…' : '载入内容'}</ActionButton></div></div>
        {selectedMetadata?.variables && Object.keys(selectedMetadata.variables).length > 0 && <div className="form-note">模板变量：{Object.entries(selectedMetadata.variables).map(([name, value]) => `${name}=${value}`).join('；')}</div>}
        <div className="two-column"><label><span>模板内容（用于内联预览）</span><textarea className="code-editor" rows={18} spellCheck={false} value={templateContent} onChange={(event) => setTemplateContent(event.target.value)}/></label><label><span>代理节点 JSON 数组</span><textarea className="code-editor" rows={18} spellCheck={false} value={proxiesText} onChange={(event) => setProxiesText(event.target.value)}/></label></div>
        <label><span>标签（逗号或换行分隔，用当前账户节点预览）</span><input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="例如 HK, US, JP"/></label>
        <div className="action-strip"><ActionButton type="button" disabled={busy !== '' || !templateName} onClick={() => void render('process')}>处理已保存模板</ActionButton><ActionButton type="button" variant="secondary" disabled={busy !== '' || !templateContent.trim()} onClick={() => void render('preview')}>预览编辑内容</ActionButton><ActionButton type="button" variant="ghost" disabled={busy !== '' || !templateName} onClick={() => void render('tags')}>按标签预览</ActionButton></div>
      </div> : mode === 'convert' ? <div className="stack-form"><label><span>V2 / ACL4SSR 模板内容</span><textarea className="code-editor" rows={20} spellCheck={false} value={v2Content} onChange={(event) => setV2Content(event.target.value)}/></label><ActionButton type="button" disabled={busy !== ''} onClick={() => void convert()}>{busy === 'convert' ? '转换中…' : '转换为 V3 结构'}</ActionButton></div> : <div className="stack-form"><label><span>订阅原始内容</span><textarea className="code-editor" rows={20} spellCheck={false} value={subscriptionContent} onChange={(event) => setSubscriptionContent(event.target.value)}/></label><ActionButton type="button" disabled={busy !== ''} onClick={() => void analyzeSubscription()}>{busy === 'analyze' ? '分析中…' : '分析并生成 V3 模板'}</ActionButton>{Object.keys(filters).length > 0 && <details className="form-note"><summary>查看后端区域过滤器</summary><pre>{JSON.stringify(filters, null, 2)}</pre></details>}</div>}
    </Panel>
    <div className="two-column"><Panel><div className="card-head"><div><h2>{mode === 'analyze' ? '生成的 V3 模板' : '处理结果'}</h2><p>结果可复制到新模板文件后再上传。</p></div></div>{output ? <textarea className="code-editor" rows={24} readOnly value={output}/> : <Empty title="暂无结果" description="执行上方操作后在这里查看输出。"/>}</Panel>{mode === 'analyze' && <Panel><div className="card-head"><div><h2>订阅分析</h2><p>节点区域、标签与规则集识别结果。</p></div></div>{analysis ? <textarea className="code-editor" rows={24} readOnly value={analysis}/> : <Empty title="暂无分析" description="提交订阅内容后显示分析详情。"/>}</Panel>}</div>
  </div>
}
