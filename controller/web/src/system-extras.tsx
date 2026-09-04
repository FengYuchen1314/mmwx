import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { api, apiURL } from './api'

type FeedbackState = { message: string; error: boolean }
type Branding = { site_title: string; brand_title: string; logo_url: string }
type AnnouncementTypeConfig = {
  enabled: boolean
  title: string
  template: string
  via_bot: boolean
  via_miniapp: boolean
}

const emptyFeedback: FeedbackState = { message: '', error: false }
const emptyBranding: Branding = { site_title: '', brand_title: '', logo_url: '' }
const announcementOrder = ['node_blocked', 'node_recovered', 'maintenance', 'sub_update', 'general']
const announcementLabels: Record<string, string> = {
  node_blocked: '节点异常',
  node_recovered: '节点恢复',
  maintenance: '系统维护',
  sub_update: '订阅更新',
  general: '通用公告',
}

function messageOf(reason: unknown, fallback = '操作失败') {
  return reason instanceof Error ? reason.message : fallback
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}响应格式不完整`)
  return value as Record<string, unknown>
}

function stringOf(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label}响应格式不完整`)
  return value
}

function booleanOf(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label}响应格式不完整`)
  return value
}

function numberOf(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}响应格式不完整`)
  return value
}

function Button({ children, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button {...props} className={`btn ${variant} ${props.className ?? ''}`}>{children}</button>
}

function Header({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return <div className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</div>
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`pixel-card ${className}`}>{children}</section>
}

function Feedback({ state }: { state: FeedbackState }) {
  return state.message ? <div className={`notice ${state.error ? 'error' : ''}`} role="status" aria-live="polite">{state.message}</div> : null
}

function Spinner() {
  return <div className="loading"><span className="operation-spinner"/>正在读取设置…</div>
}

function Toggle({ title, detail, checked, disabled = false, onChange }: { title: string; detail: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className="setting"><div><strong>{title}</strong><small>{detail}</small></div><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)}/><span className="switch"/></label>
}

function GroupHeader({ title, description, loaded, loading, busy, onRefresh }: { title: string; description: string; loaded: boolean; loading: boolean; busy: boolean; onRefresh: () => void }) {
  return <div className="card-head"><div><h2>{title}</h2><p>{description}</p></div><div className="page-actions"><span className={`badge ${loaded ? 'success' : ''}`}>{loading ? '读取中' : loaded ? '已载入' : '未载入'}</span><Button type="button" variant="secondary" disabled={loading || busy} onClick={onRefresh}>刷新</Button></div></div>
}

function AppearanceGroup({ refreshKey }: { refreshKey: number }) {
  const [branding, setBranding] = useState<Branding>(emptyBranding)
  const [wallpaper, setWallpaper] = useState('')
  const [featureEnabled, setFeatureEnabled] = useState(false)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>(emptyFeedback)

  const load = useCallback(async (keepFeedback = false) => {
    setLoading(true)
    setLoaded(false)
    setBranding(emptyBranding)
    setWallpaper('')
    setFeatureEnabled(false)
    if (!keepFeedback) setFeedback(emptyFeedback)
    try {
      const [brandingResponse, wallpaperResponse] = await Promise.all([
        api<unknown>('/api/admin/system-settings/branding'),
        api<unknown>('/api/admin/system-settings/login-wallpaper'),
      ])
      const brandingEnvelope = objectOf(brandingResponse, '品牌设置')
      const source = objectOf(brandingEnvelope.branding, '品牌设置')
      const wallpaperEnvelope = objectOf(wallpaperResponse, '登录壁纸')
      setBranding({
        site_title: stringOf(source.site_title, '站点标题'),
        brand_title: stringOf(source.brand_title, '品牌标题'),
        logo_url: stringOf(source.logo_url, 'Logo 地址'),
      })
      setFeatureEnabled(booleanOf(brandingEnvelope.feature_enabled, '品牌授权'))
      setWallpaper(stringOf(wallpaperEnvelope.login_wallpaper, '登录壁纸'))
      setLoaded(true)
      return true
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '读取外观设置失败'), error: true })
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load, refreshKey])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!loaded) {
      setFeedback({ message: '外观设置尚未完整载入，已阻止保存。请刷新后重试。', error: true })
      return
    }
    setBusy(true)
    setFeedback(emptyFeedback)
    try {
      await Promise.all([
        api('/api/admin/system-settings/branding', { method: 'POST', body: JSON.stringify(branding) }),
        api('/api/admin/system-settings/login-wallpaper', { method: 'PUT', body: JSON.stringify({ login_wallpaper: wallpaper }) }),
      ])
      if (await load(true)) {
        setFeedback({ message: '品牌与登录页设置已保存。', error: false })
        window.dispatchEvent(new Event('mmwx:appearance-updated'))
      }
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '保存外观设置失败'), error: true })
    } finally {
      setBusy(false)
    }
  }

  const uploadLogo = async () => {
    if (!loaded) {
      setFeedback({ message: '品牌设置尚未完整载入，已阻止上传。', error: true })
      return
    }
    if (!logoFile) {
      setFeedback({ message: '请先选择 Logo 图片。', error: true })
      return
    }
    if (logoFile.size > 2 * 1024 * 1024) {
      setFeedback({ message: 'Logo 文件不能超过 2MB。', error: true })
      return
    }
    setBusy(true)
    setFeedback(emptyFeedback)
    try {
      const body = new FormData()
      body.append('logo', logoFile)
      const response = objectOf(await api<unknown>('/api/admin/system-settings/branding/logo', { method: 'POST', body }), 'Logo 上传')
      const logoURL = stringOf(response.logo_url, 'Logo 地址')
      setBranding((old) => ({ ...old, logo_url: logoURL }))
      setLogoFile(null)
      setFeedback({ message: 'Logo 已上传并写入品牌设置。', error: false })
      window.dispatchEvent(new Event('mmwx:appearance-updated'))
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '上传 Logo 失败'), error: true })
    } finally {
      setBusy(false)
    }
  }

  return <Card className="settings-card"><form onSubmit={(event) => void save(event)}>
    <GroupHeader title="品牌与登录页" description="站点标题、品牌 Logo 与登录壁纸" loaded={loaded} loading={loading} busy={busy} onRefresh={() => void load()}/>
    <Feedback state={feedback}/>
    {loading ? <Spinner/> : <div className="stack-form">
      {!featureEnabled && <div className="form-note">自定义品牌配置可以保存，但后端只会在 Custom Branding 授权有效时公开显示。</div>}
      <div className="field-row"><label><span>浏览器标签标题</span><input value={branding.site_title} disabled={!loaded || busy} onChange={(event) => setBranding((old) => ({ ...old, site_title: event.target.value }))} placeholder="妙妙屋 X"/></label><label><span>导航品牌标题</span><input value={branding.brand_title} disabled={!loaded || busy} onChange={(event) => setBranding((old) => ({ ...old, brand_title: event.target.value }))} placeholder="妙妙屋 X"/></label></div>
      <label><span>Logo 外部地址或内部路径</span><input value={branding.logo_url} disabled={!loaded || busy} onChange={(event) => setBranding((old) => ({ ...old, logo_url: event.target.value }))} placeholder="https://example.com/logo.png"/></label>
      <div className="field-row"><label><span>上传 Logo（png/jpg/webp/gif/svg/ico，最大 2MB）</span><input type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.ico" disabled={!loaded || busy} onChange={(event) => setLogoFile(event.target.files?.[0] ?? null)}/></label><div className="stack-form">{branding.logo_url && <img className="logo" src={apiURL(branding.logo_url)} alt="当前品牌 Logo" style={{ objectFit: 'contain' }}/>}<Button type="button" variant="secondary" disabled={!loaded || busy || !logoFile} onClick={() => void uploadLogo()}>{busy ? '处理中…' : '上传 Logo'}</Button></div></div>
      <label><span>登录壁纸 URL</span><input value={wallpaper} maxLength={2000} disabled={!loaded || busy} onChange={(event) => setWallpaper(event.target.value)} placeholder="https://example.com/wallpaper.webp"/></label>
      <div className="form-note">登录壁纸后端仅提供 URL 配置，没有 multipart 文件上传端点；留空即可恢复默认背景。</div>
      {wallpaper && <div className="update-card"><div><small>壁纸预览</small><p>{wallpaper}</p></div><img src={apiURL(wallpaper)} alt="登录壁纸预览" style={{ width: 112, height: 70, borderRadius: 7, objectFit: 'cover' }}/></div>}
      <div className="settings-actions"><Button type="submit" disabled={!loaded || busy}>{busy ? '保存中…' : '保存品牌与登录页'}</Button></div>
    </div>}
  </form></Card>
}

function FeatureSwitchesGroup({ refreshKey }: { refreshKey: number }) {
  const [shortLink, setShortLink] = useState(false)
  const [updateCDN, setUpdateCDN] = useState(false)
  const [cdnBase, setCDNBase] = useState('')
  const [miaomiaowuFeatures, setMiaomiaowuFeatures] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>(emptyFeedback)

  const load = useCallback(async (keepFeedback = false) => {
    setLoading(true)
    setLoaded(false)
    setShortLink(false)
    setUpdateCDN(false)
    setCDNBase('')
    setMiaomiaowuFeatures(false)
    if (!keepFeedback) setFeedback(emptyFeedback)
    try {
      const [shortResponse, cdnResponse, featureResponse] = await Promise.all([
        api<unknown>('/api/admin/system-settings/short-link'),
        api<unknown>('/api/admin/system-settings/update-cdn'),
        api<unknown>('/api/admin/system-settings/miaomiaowu-features'),
      ])
      const shortEnvelope = objectOf(shortResponse, '短链接设置')
      const cdnEnvelope = objectOf(cdnResponse, '更新 CDN 设置')
      const featureEnvelope = objectOf(featureResponse, '妙妙屋功能设置')
      setShortLink(booleanOf(shortEnvelope.enable_short_link, '短链接设置'))
      setUpdateCDN(booleanOf(cdnEnvelope.enabled, '更新 CDN 设置'))
      setCDNBase(stringOf(cdnEnvelope.cdn_base, '更新 CDN 地址'))
      setMiaomiaowuFeatures(booleanOf(featureEnvelope.enable_miaomiaowu_features, '妙妙屋功能设置'))
      setLoaded(true)
      return true
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '读取功能开关失败'), error: true })
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load, refreshKey])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!loaded) {
      setFeedback({ message: '功能开关尚未完整载入，已阻止保存。请刷新后重试。', error: true })
      return
    }
    setBusy(true)
    setFeedback(emptyFeedback)
    try {
      // These three endpoints each read and then update the shared SystemConfig
      // row. Saving them in order prevents one stale snapshot from reverting a
      // setting written by another request.
      await api('/api/admin/system-settings/short-link', { method: 'PUT', body: JSON.stringify({ enable_short_link: shortLink }) })
      await api('/api/admin/system-settings/update-cdn', { method: 'PUT', body: JSON.stringify({ enabled: updateCDN }) })
      await api('/api/admin/system-settings/miaomiaowu-features', { method: 'PUT', body: JSON.stringify({ enable_miaomiaowu_features: miaomiaowuFeatures }) })
      if (await load(true)) setFeedback({ message: '功能开关已保存并立即生效。', error: false })
    } catch (reason) {
      await load(true)
      setFeedback({ message: `${messageOf(reason, '保存功能开关失败')}；已重新读取服务端状态，前序项目可能已生效。`, error: true })
    } finally {
      setBusy(false)
    }
  }

  return <Card className="settings-card"><form onSubmit={(event) => void save(event)}>
    <GroupHeader title="功能与更新" description="短链接、更新分发与妙妙屋扩展功能" loaded={loaded} loading={loading} busy={busy} onRefresh={() => void load()}/>
    <Feedback state={feedback}/>
    {loading ? <Spinner/> : <div className="stack-form"><div className="setting-list">
      <Toggle title="订阅短链接" detail="允许使用 /x/{code} 形式访问订阅" checked={shortLink} disabled={!loaded || busy} onChange={setShortLink}/>
      <Toggle title="更新使用 CDN" detail={cdnBase ? `更新包从 ${cdnBase} 分发；关闭后回退 GitHub` : '关闭后直接从 GitHub 获取更新'} checked={updateCDN} disabled={!loaded || busy} onChange={setUpdateCDN}/>
      <Toggle title="妙妙屋扩展功能" detail="启用后端提供的妙妙屋专属功能集合" checked={miaomiaowuFeatures} disabled={!loaded || busy} onChange={setMiaomiaowuFeatures}/>
    </div><div className="settings-actions"><Button type="submit" disabled={!loaded || busy}>{busy ? '保存中…' : '保存功能开关'}</Button></div></div>}
  </form></Card>
}

function RuntimeAndCopyGroup({ refreshKey }: { refreshKey: number }) {
  const [refreshMs, setRefreshMs] = useState('5000')
  const [redeemTemplate, setRedeemTemplate] = useState('')
  const [prefixEnabled, setPrefixEnabled] = useState(false)
  const [prefixLeft, setPrefixLeft] = useState('「')
  const [prefixRight, setPrefixRight] = useState('」')
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>(emptyFeedback)

  const load = useCallback(async (keepFeedback = false) => {
    setLoading(true)
    setLoaded(false)
    setRefreshMs('5000')
    setRedeemTemplate('')
    setPrefixEnabled(false)
    setPrefixLeft('「')
    setPrefixRight('」')
    if (!keepFeedback) setFeedback(emptyFeedback)
    try {
      const [refreshResponse, redeemResponse, prefixResponse] = await Promise.all([
        api<unknown>('/api/system-config/refetch-interval'),
        api<unknown>('/api/admin/system-settings/redeem-template'),
        api<unknown>('/api/admin/system-settings/node-name-multiplier-prefix'),
      ])
      const refreshEnvelope = objectOf(refreshResponse, '刷新间隔')
      const redeemEnvelope = objectOf(redeemResponse, '兑换码文案')
      const prefixEnvelope = objectOf(prefixResponse, '倍率前缀')
      setRefreshMs(String(numberOf(refreshEnvelope.refetch_interval_ms, '刷新间隔')))
      setRedeemTemplate(stringOf(redeemEnvelope.redeem_template, '兑换码文案'))
      setPrefixEnabled(booleanOf(prefixEnvelope.enabled, '倍率前缀'))
      setPrefixLeft(stringOf(prefixEnvelope.left, '倍率左分隔符'))
      setPrefixRight(stringOf(prefixEnvelope.right, '倍率右分隔符'))
      setLoaded(true)
      return true
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '读取运行与文案设置失败'), error: true })
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load, refreshKey])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!loaded) {
      setFeedback({ message: '运行与文案设置尚未完整载入，已阻止保存。请刷新后重试。', error: true })
      return
    }
    const interval = Number(refreshMs)
    if (!Number.isInteger(interval) || interval < 1000 || interval > 60000) {
      setFeedback({ message: '面板刷新与 Agent 上报间隔必须是 1000–60000 毫秒的整数。', error: true })
      return
    }
    setBusy(true)
    setFeedback(emptyFeedback)
    try {
      await Promise.all([
        api('/api/admin/system-settings/dashboard-refresh', { method: 'PUT', body: JSON.stringify({ refetch_interval_ms: interval }) }),
        api('/api/admin/system-settings/redeem-template', { method: 'PUT', body: JSON.stringify({ redeem_template: redeemTemplate }) }),
        api('/api/admin/system-settings/node-name-multiplier-prefix', { method: 'PUT', body: JSON.stringify({ enabled: prefixEnabled, left: prefixLeft, right: prefixRight }) }),
      ])
      if (await load(true)) setFeedback({ message: '刷新频率、倍率前缀与兑换码文案已保存。', error: false })
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '保存运行与文案设置失败'), error: true })
    } finally {
      setBusy(false)
    }
  }

  return <Card className="settings-card"><form onSubmit={(event) => void save(event)}>
    <GroupHeader title="运行频率与展示文案" description="面板刷新/Agent 上报、倍率标记和兑换码复制模板" loaded={loaded} loading={loading} busy={busy} onRefresh={() => void load()}/>
    <Feedback state={feedback}/>
    {loading ? <Spinner/> : <div className="stack-form">
      <label><span>面板刷新与 Agent 上报间隔（毫秒）</span><input type="number" min={1000} max={60000} step={1000} value={refreshMs} disabled={!loaded || busy} onChange={(event) => setRefreshMs(event.target.value)}/></label>
      <div className="form-note">该值会被后端限制在 1–60 秒，并同步给在线 Agent 与主控本机采集器。</div>
      <div className="setting-list"><Toggle title="节点名称显示倍率前缀" detail={`示例：${prefixLeft || '「'}2${prefixRight || '」'}香港节点`} checked={prefixEnabled} disabled={!loaded || busy} onChange={setPrefixEnabled}/></div>
      <div className="field-row"><label><span>倍率左分隔符</span><input value={prefixLeft} disabled={!loaded || busy} onChange={(event) => setPrefixLeft(event.target.value)} placeholder="「"/></label><label><span>倍率右分隔符</span><input value={prefixRight} disabled={!loaded || busy} onChange={(event) => setPrefixRight(event.target.value)} placeholder="」"/></label></div>
      <label><span>兑换码复制文案模板</span><textarea className="code-area" rows={9} value={redeemTemplate} disabled={!loaded || busy} onChange={(event) => setRedeemTemplate(event.target.value)}/></label>
      <div className="form-note">可使用后端支持的占位符：{'{机器人地址}'}、{'{兑换码}'}、{'{主控域名}'}。</div>
      <div className="settings-actions"><Button type="submit" disabled={!loaded || busy}>{busy ? '保存中…' : '保存运行与文案设置'}</Button></div>
    </div>}
  </form></Card>
}

function parseAnnouncementTypes(value: unknown) {
  const source = objectOf(value, '公告类型')
  const result: Record<string, AnnouncementTypeConfig> = {}
  for (const [key, raw] of Object.entries(source)) {
    const item = objectOf(raw, `公告类型 ${key}`)
    result[key] = {
      enabled: booleanOf(item.enabled, `公告类型 ${key}`),
      title: stringOf(item.title, `公告类型 ${key}`),
      template: stringOf(item.template, `公告类型 ${key}`),
      via_bot: booleanOf(item.via_bot, `公告类型 ${key}`),
      via_miniapp: booleanOf(item.via_miniapp, `公告类型 ${key}`),
    }
  }
  if (Object.keys(result).length === 0) throw new Error('公告类型响应为空')
  return result
}

function parseProbeTesterIDs(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isSafeInteger(item))) throw new Error('公告探测源响应格式不完整')
  return value as number[]
}

function parseProbeTesterInput(value: string) {
  const parts = value.trim() ? value.trim().split(/[\s,，]+/).filter(Boolean) : []
  const ids = parts.map(Number)
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('测速端 ID 必须是以逗号或空格分隔的正整数')
  return [...new Set(ids)]
}

function AnnouncementsGroup({ refreshKey }: { refreshKey: number }) {
  const [types, setTypes] = useState<Record<string, AnnouncementTypeConfig>>({})
  const [probeTesterIDs, setProbeTesterIDs] = useState('')
  const [officialProbe, setOfficialProbe] = useState(false)
  const [officialProbeAvailable, setOfficialProbeAvailable] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackState>(emptyFeedback)

  const orderedTypeNames = useMemo(() => {
    const known = announcementOrder.filter((key) => Object.prototype.hasOwnProperty.call(types, key))
    const unknown = Object.keys(types).filter((key) => !announcementOrder.includes(key)).sort()
    return [...known, ...unknown]
  }, [types])

  const load = useCallback(async (keepFeedback = false) => {
    setLoading(true)
    setLoaded(false)
    setTypes({})
    setProbeTesterIDs('')
    setOfficialProbe(false)
    setOfficialProbeAvailable(false)
    if (!keepFeedback) setFeedback(emptyFeedback)
    try {
      const envelope = objectOf(await api<unknown>('/api/admin/system-settings/announcements'), '公告配置')
      const config = objectOf(envelope.config, '公告配置')
      setTypes(parseAnnouncementTypes(config.types))
      setProbeTesterIDs(parseProbeTesterIDs(envelope.probe_tester_ids).join(', '))
      setOfficialProbe(booleanOf(envelope.official_probe, '官方探测'))
      setOfficialProbeAvailable(booleanOf(envelope.official_probe_available, '官方探测授权'))
      setLoaded(true)
      return true
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '读取公告配置失败'), error: true })
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load, refreshKey])

  const updateType = (name: string, patch: Partial<AnnouncementTypeConfig>) => {
    setTypes((old) => ({ ...old, [name]: { ...old[name], ...patch } }))
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!loaded) {
      setFeedback({ message: '公告配置尚未完整载入，已阻止保存。请刷新后重试。', error: true })
      return
    }
    let testerIDs: number[]
    try {
      testerIDs = parseProbeTesterInput(probeTesterIDs)
    } catch (reason) {
      setFeedback({ message: messageOf(reason), error: true })
      return
    }
    setBusy(true)
    setFeedback(emptyFeedback)
    try {
      await api('/api/admin/system-settings/announcements', {
        method: 'PUT',
        body: JSON.stringify({ config: { types }, probe_tester_ids: testerIDs, official_probe: officialProbe }),
      })
      if (await load(true)) setFeedback({ message: '公告模板与探测源设置已保存。', error: false })
    } catch (reason) {
      setFeedback({ message: messageOf(reason, '保存公告配置失败'), error: true })
    } finally {
      setBusy(false)
    }
  }

  return <Card className="settings-card"><form onSubmit={(event) => void save(event)}>
    <GroupHeader title="公告模板与被墙探测" description="配置五类公告、投递渠道和家庭测速端探测源" loaded={loaded} loading={loading} busy={busy} onRefresh={() => void load()}/>
    <Feedback state={feedback}/>
    {loading ? <Spinner/> : <div className="stack-form">
      <div className="field-row"><label><span>家用测速端 ID</span><input value={probeTesterIDs} disabled={!loaded || busy} onChange={(event) => setProbeTesterIDs(event.target.value)} placeholder="1, 2, 3"/><small>使用逗号或空格分隔；留空表示不使用本地探测端。</small></label><div className="setting-list"><Toggle title="官方探测源（PRO）" detail={officialProbeAvailable ? '与本地家用测速端取可达结果并集' : '当前许可证未开放 Speed Test 功能'} checked={officialProbe} disabled={!loaded || busy || (!officialProbeAvailable && !officialProbe)} onChange={setOfficialProbe}/></div></div>
      {!officialProbeAvailable && <div className="form-note">授权不可用时不能新开启官方探测；若旧配置仍为开启状态，可以在此关闭。</div>}
      <div className="detail-panels">{orderedTypeNames.map((name) => {
        const item = types[name]
        return <section key={name} className="stack-form"><div><h3>{announcementLabels[name] ?? name}</h3><span className="chip">{name}</span></div><div className="setting-list"><Toggle title="启用该类公告" detail="关闭后自动事件不会创建此类公告" checked={item.enabled} disabled={!loaded || busy} onChange={(enabled) => updateType(name, { enabled })}/><Toggle title="Telegram Bot" detail="通过 Bot 广播给符合套餐范围的绑定用户" checked={item.via_bot} disabled={!loaded || busy} onChange={(via_bot) => updateType(name, { via_bot })}/><Toggle title="面板与 Mini App" detail="在登录后的公告横幅中展示" checked={item.via_miniapp} disabled={!loaded || busy} onChange={(via_miniapp) => updateType(name, { via_miniapp })}/></div><label><span>标题</span><input value={item.title} disabled={!loaded || busy} onChange={(event) => updateType(name, { title: event.target.value })}/></label><label><span>文案模板</span><textarea rows={4} value={item.template} disabled={!loaded || busy} onChange={(event) => updateType(name, { template: event.target.value })}/></label></section>
      })}</div>
      <div className="form-note">节点公告模板可使用 {'{node}'}，维护等时间文案可使用 {'{time}'}；模板替换由后端执行。</div>
      <div className="settings-actions"><Button type="submit" disabled={!loaded || busy}>{busy ? '保存中…' : '保存公告设置'}</Button></div>
    </div>}
  </form></Card>
}

export function AdvancedSystemSettingsPage() {
  const [refreshKey, setRefreshKey] = useState(0)
  return <>
    <Header title="高级系统设置" description="品牌、运行频率、功能开关与公告策略" actions={<Button type="button" variant="secondary" onClick={() => setRefreshKey((value) => value + 1)}>全部刷新</Button>}/>
    <div className="stack-form">
      <div className="two-column"><AppearanceGroup refreshKey={refreshKey}/><FeatureSwitchesGroup refreshKey={refreshKey}/></div>
      <RuntimeAndCopyGroup refreshKey={refreshKey}/>
      <AnnouncementsGroup refreshKey={refreshKey}/>
    </div>
  </>
}
