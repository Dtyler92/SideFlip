import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import {
  MAX_CURRENCY_AMOUNT, MAX_PLATFORM_FEE_PERCENT, MAX_ROI_PERCENT,
  analyzeDeal, calculateListPrice, calculateMaximumBuyPrice, calculateProfit,
  normalizeCurrencyAmount, projectAnalysisDraft, quickDealCheck,
} from '../domain/analyzeModel'
import {
  MAX_SAVED_ANALYSES, assertAnalysisCurrency, deleteSavedAnalysis, loadSavedAnalyses, saveAnalysis,
} from '../storage/analysisStore'


export const ANALYZE_TOOLS = Object.freeze([
  { key: 'deal', label: 'Deal Analyzer', icon: '📈' },
  { key: 'quick', label: 'Quick Deal Check', icon: '⚡' },
  { key: 'list', label: 'List Price Calculator', icon: '🏷️' },
  { key: 'max', label: 'Maximum Buy Price', icon: '🎯' },
  { key: 'profit', label: 'Profit Calculator', icon: '💵' },
])
export const PLATFORM_PRESETS = Object.freeze([
  { key: 'none', label: 'None', fee: '0' },
  { key: 'facebook', label: 'Facebook', fee: '0' },
  { key: 'ebay', label: 'eBay', fee: '13' },
  { key: 'craigslist', label: 'Craigslist', fee: '0' },
  { key: 'custom', label: 'Custom', fee: '' },
])
export const ROI_PRESETS = Object.freeze(['10', '25', '50', '100', '150'])

const CURRENCY_SYMBOLS = { USD:'$', CAD:'CA$', GBP:'£', EUR:'€', AUD:'A$', MXN:'MX$', JPY:'¥', INR:'₹' }
const EMPTY_DEAL = { itemName:'', projectId:null, purchasePrice:'', repairsMaterials:'', parts:'', fuelTravel:'', shippingCost:'', otherExpenses:'', expectedSellingPrice:'', platformFeePct:'0', sellerPaidShipping:'', salesTaxOtherFees:'', desiredMinimumProfit:'' }
const EMPTY_QUICK = { askingPrice:'', estimatedRepairs:'', expectedResaleValue:'', desiredMinimumProfit:'' }
const EMPTY_LIST = { totalInvested:'', targetMode:'profit', targetValue:'', platformFeePct:'0', sellerPaidShipping:'', additionalSellingCosts:'' }
const EMPTY_MAX = { expectedSellingPrice:'', nonPurchaseExpenses:'', desiredMinimumProfit:'', platformFeePct:'0', sellerPaidShipping:'', otherSellingCosts:'' }
const EMPTY_PROFIT = { totalInvested:'', sellingPrice:'', platformFeePct:'0', sellerPaidShipping:'', additionalSellingCosts:'' }

const ANALYZE_STYLES = `
.analyze-page{max-width:980px;margin:0 auto;padding:24px 20px 104px;color:var(--text,#1a1917)}
.analyze-heading p,.analyze-hero p,.analyze-result-note{color:var(--muted,#6b675f)}
.analyze-tool-nav{display:flex;gap:9px;overflow-x:auto;padding:4px 0 16px}.analyze-tool-nav button{flex:0 0 150px;min-height:72px;border:1px solid var(--border,#e8e4de);border-radius:14px;background:#fff;padding:12px;font-weight:700}.analyze-tool-nav button.selected{background:#1a1917;color:#fff}
.analyze-hero{background:#fff1ec;border-radius:16px;padding:18px;margin-bottom:12px}.analyze-hero>span{color:#c8402f;font-size:11px;font-weight:800;letter-spacing:1px}.analyze-hero h2{margin:5px 0}.analyze-project-button{width:100%;min-height:48px;margin-bottom:12px;border:0;border-radius:12px;background:#1a1917;color:#fff;font-weight:700}
.analyze-card,.analyze-results{background:#fff;border:1px solid var(--border,#e8e4de);border-radius:16px;padding:16px;margin-bottom:14px}.analyze-field{margin-bottom:14px}.analyze-field label,.analyze-chip-field legend{display:block;margin-bottom:7px;color:var(--muted,#5c5850);font-size:13px;font-weight:700}.analyze-input-wrap{display:flex;align-items:center;min-height:48px;border:1px solid var(--border,#e8e4de);border-radius:11px;background:#fafaf7}.analyze-input-wrap span{padding-left:13px;color:#6b675f;font-weight:700}.analyze-input-wrap input{width:100%;min-width:0;border:0;background:transparent;padding:12px;font:inherit;color:inherit}.analyze-input-wrap input:focus{outline:2px solid #c8402f;outline-offset:2px}.analyze-chip-field{border:0;padding:0;margin:0 0 14px}.analyze-chips{display:flex;flex-wrap:wrap;gap:7px}.analyze-chips button{min-height:44px;border:1px solid var(--border,#e8e4de);border-radius:22px;background:#f5f2ee;padding:10px 12px;font-weight:700}.analyze-chips button.selected{background:#c8402f;color:#fff}.analyze-platform small,.analyze-field small,.analyze-disclosure,.analyze-private{display:block;color:#6b675f;font-size:12px;line-height:1.5}
.analyze-rating{border:2px solid;border-radius:13px;padding:14px;margin-bottom:14px}.analyze-rating.negative{border-color:#c8402f}.analyze-rating.caution{border-color:#9a6500}.analyze-rating.strong,.analyze-rating.positive{border-color:#2d7a4f}.analyze-rating p{margin:4px 0 0}.analyze-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.analyze-metric{min-width:0;min-height:78px;border-radius:12px;background:#f5f2ee;padding:12px}.analyze-metric span{display:block;color:#6b675f;font-size:10px;font-weight:700;text-transform:uppercase}.analyze-metric strong{display:block;margin-top:7px;font-size:18px;overflow-wrap:anywhere}.analyze-metric.primary{background:#fff1ec}.analyze-metric.positive strong{color:#2d7a4f}.analyze-metric.negative strong{color:#c8402f}.analyze-results>.btn{width:100%;margin-top:14px}
.analyze-notice{margin-bottom:12px;border-radius:10px;background:#e8f5ee;padding:12px}.analyze-notice.error{background:#fff1ec;color:#a22f22}.analyze-saved article{display:flex;align-items:center;border-bottom:1px solid #f0ede8}.analyze-saved article button:first-of-type{flex:1;text-align:left}.analyze-saved article button{min-height:48px;border:0;background:transparent;padding:10px}.analyze-saved article span{display:block;color:#6b675f;font-size:12px}.analyze-saved .delete{color:#c8402f;font-weight:700}
.analyze-modal-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;background:rgba(0,0,0,.45);padding:20px}.analyze-modal{width:min(620px,100%);max-height:85vh;overflow:auto;border-radius:16px;background:#fafaf7;padding:16px}.analyze-modal header{display:flex;align-items:center;justify-content:space-between}.analyze-modal header button,.analyze-project-list button{min-height:44px}.analyze-modal>input{width:100%;min-height:46px;margin:8px 0 14px;padding:10px}.analyze-project-list button{display:flex;width:100%;align-items:center;justify-content:space-between;border:0;border-bottom:1px solid #e8e4de;background:#fff;padding:14px;text-align:left}.analyze-project-list small{display:block;color:#6b675f}
@media (max-width:600px){.analyze-page{padding:18px 14px 96px}.analyze-tool-nav button{flex-basis:124px}.analyze-metric strong{font-size:16px}.analyze-modal-backdrop{align-items:end;padding:0}.analyze-modal{max-height:92vh;border-radius:16px 16px 0 0}}
`

function boundedNumericText(value, maximum) {
  const text = String(value ?? '').replace(/[^0-9.]/g, '')
  if (!text) return ''
  const firstDot = text.indexOf('.')
  const cleaned = firstDot < 0 ? text : `${text.slice(0, firstDot + 1)}${text.slice(firstDot + 1).replaceAll('.', '')}`
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) && parsed > maximum ? String(maximum) : cleaned
}
function moneyFormatter(currency) {
  const code = CURRENCY_SYMBOLS[currency] ? currency : 'USD'
  return value => {
    const numeric = Number(value)
    const amount = Number.isFinite(numeric) ? numeric : 0
    const digits = code === 'JPY' ? 0 : 2
    return `${amount < 0 ? '-' : ''}${CURRENCY_SYMBOLS[code]}${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits:digits, maximumFractionDigits:digits })}`
  }
}
const pct = value => value == null ? 'N/A' : `${Number(value).toFixed(1)}%`

function Field({ label, value, onChange, money = true, symbol = '$', placeholder = '0.00', maximum = money ? MAX_CURRENCY_AMOUNT : undefined, hint }) {
  const id = useId()
  return <div className="analyze-field">
    <label htmlFor={id}>{label}</label>
    <div className="analyze-input-wrap">
      {money && <span aria-hidden="true">{symbol}</span>}
      <input id={id} type={money || maximum != null ? 'text' : 'text'} inputMode={money || maximum != null ? 'decimal' : 'text'}
        value={value ?? ''} placeholder={placeholder} maxLength={money || maximum != null ? 14 : 120}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={event => onChange(maximum == null ? event.target.value : boundedNumericText(event.target.value, maximum))}/>
    </div>
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </div>
}
function ChipGroup({ label, options, value, onChange }) {
  return <fieldset className="analyze-chip-field"><legend>{label}</legend><div className="analyze-chips">
    {options.map(option => <button key={option.key} type="button" className={value === option.key ? 'selected' : ''}
      aria-pressed={value === option.key} onClick={() => onChange(option.key)}>{option.label}</button>)}
  </div></fieldset>
}
function PlatformPicker({ preset, setPreset, fee, setFee }) {
  const choose = key => {
    setPreset(key)
    const found = PLATFORM_PRESETS.find(option => option.key === key)
    if (key !== 'custom') setFee(found?.fee || '0')
  }
  return <div className="analyze-platform">
    <ChipGroup label="Selling Platform / Fee" options={PLATFORM_PRESETS} value={preset} onChange={choose}/>
    {preset === 'custom'
      ? <Field label="Custom platform fee percentage" money={false} maximum={MAX_PLATFORM_FEE_PERCENT} value={fee} onChange={setFee} placeholder="Custom fee"/>
      : <small>{fee || '0'}% estimated platform fee. Choose Custom to edit it.</small>}
  </div>
}
function Hero({ eyebrow, title, children }) {
  return <header className="analyze-hero">{eyebrow && <span>{eyebrow}</span>}<h2>{title}</h2><p>{children}</p></header>
}
function Metric({ label, value, tone = '', primary = false }) {
  return <div className={`analyze-metric ${primary ? 'primary' : ''} ${tone}`}><span>{label}</span><strong>{value}</strong></div>
}
function Rating({ result }) {
  return <div className={`analyze-rating ${result.ratingTone}`} aria-live="polite"><strong>{result.dealRating}</strong><p>{result.ratingExplanation}</p></div>
}
function Results({ children }) { return <section className="analyze-results" aria-label="Analysis results" aria-live="polite">{children}</section> }
function MoneyField({ currency, ...props }) { return <Field {...props} symbol={CURRENCY_SYMBOLS[currency] || '$'}/> }

export default function Analyze({ projectId = null, onProjectPrefillConsumed }) {
  const { user, profile } = useAuth()
  const { projects = [] } = useData()
  const currency = profile?.currency || 'USD'
  const money = useMemo(() => moneyFormatter(currency), [currency])
  const [tool, setTool] = useState('deal')
  const [deal, setDeal] = useState(EMPTY_DEAL)
  const [quick, setQuick] = useState(EMPTY_QUICK)
  const [list, setList] = useState(EMPTY_LIST)
  const [maxBuy, setMaxBuy] = useState(EMPTY_MAX)
  const [profit, setProfit] = useState(EMPTY_PROFIT)
  const [platform, setPlatform] = useState('none')
  const [listPlatform, setListPlatform] = useState('none')
  const [maxPlatform, setMaxPlatform] = useState('none')
  const [profitPlatform, setProfitPlatform] = useState('none')
  const [roiPreset, setRoiPreset] = useState('custom')
  const [saved, setSaved] = useState([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [projectSearch, setProjectSearch] = useState('')
  const saveInFlight = useRef(false)
  const pickerButton = useRef(null)
  const pickerDialog = useRef(null)

  const dealResult = useMemo(() => analyzeDeal(deal), [deal])
  const quickResult = useMemo(() => quickDealCheck(quick), [quick])
  const listResult = useMemo(() => calculateListPrice(list), [list])
  const maxResult = useMemo(() => calculateMaximumBuyPrice(maxBuy), [maxBuy])
  const profitResult = useMemo(() => calculateProfit(profit), [profit])

  useEffect(() => {
    let active = true
    setError('')
    loadSavedAnalyses(user?.id).then(rows => { if (active) setSaved(rows) }).catch(reason => { if (active) setError(reason.message) })
    return () => { active = false }
  }, [user?.id])

  function applyProject(project) {
    const draft = projectAnalysisDraft(project)
    const textDraft = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value == null ? '' : String(value)]))
    setDeal({ ...EMPTY_DEAL, ...textDraft })
    setList({ ...EMPTY_LIST, totalInvested:String(draft.totalInvested) })
    setPlatform('none'); setListPlatform('none'); setTool('deal'); setPickerOpen(false); setProjectSearch('')
    setNotice('Project values copied into a private analysis copy. Your Project and expenses will not be changed.')
  }

  useEffect(() => {
    if (!projectId || !projects.length) return
    const project = projects.find(candidate => candidate.id === projectId)
    if (project) applyProject(project)
    else setError('That Project could not be loaded. Choose another Project to analyze.')
    onProjectPrefillConsumed?.(projectId, project || null)
    // A parent owns projectId lifecycle; callbacks intentionally run once per ID/project set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projects])

  useEffect(() => {
    if (!pickerOpen) return undefined
    const dialog = pickerDialog.current
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); setPickerOpen(false); return }
      if (event.key !== 'Tab' || !dialog) return
      const controls = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!controls.length) return
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); pickerButton.current?.focus() }
  }, [pickerOpen])

  async function saveCurrentDeal() {
    if (!deal.itemName.trim()) { setError('Enter an item or project name before saving.'); return }
    if (saveInFlight.current) return
    saveInFlight.current = true
    setSaving(true); setError(''); setNotice('')
    try {
      const purchasePrice = normalizeCurrencyAmount(deal.purchasePrice)
      const record = await saveAnalysis(user?.id, {
        itemName:deal.itemName.trim(), projectId:deal.projectId || null, purchasePrice,
        estimatedExpenses:dealResult.totalInvestment - purchasePrice, expectedSellingPrice:dealResult.expectedRevenue,
        platform, currency, platformFeePct:Number(deal.platformFeePct) || 0,
        projectedProfit:dealResult.expectedProfit, projectedRoi:dealResult.roiPct,
        maximumPurchasePrice:dealResult.maximumPurchasePrice,
        recommendedListPrice:calculateListPrice({ totalInvested:dealResult.totalInvestment, targetMode:'profit', targetValue:deal.desiredMinimumProfit, platformFeePct:deal.platformFeePct, sellerPaidShipping:deal.sellerPaidShipping, additionalSellingCosts:deal.salesTaxOtherFees }).recommendedListPrice,
        estimateSource:'user_entered', calculationVersion:1, inputs:{ ...deal },
      })
      setSaved(rows => [record, ...rows.filter(row => row.id !== record.id)].slice(0, MAX_SAVED_ANALYSES))
      setNotice('Analysis saved on this device. Your Project and expense records were not changed.')
    } catch (reason) { setError(reason.message) } finally { saveInFlight.current = false; setSaving(false) }
  }
  function loadAnalysis(record) {
    try {
      assertAnalysisCurrency(record, currency)
      setDeal({ ...EMPTY_DEAL, ...record.inputs, projectId:record.projectId || null, itemName:record.itemName || '' })
      setPlatform(record.platform)
      setTool('deal'); setError(''); setNotice(`${record.itemName} loaded.`)
      globalThis.scrollTo?.({ top:0, behavior:'smooth' })
    } catch (reason) { setError(reason.message) }
  }
  async function removeAnalysis(record) {
    if (!globalThis.confirm?.(`Delete analysis “${record.itemName}”?`)) return
    try { setSaved(await deleteSavedAnalysis(user?.id, record.id)); setNotice(`${record.itemName} deleted.`); setError('') }
    catch (reason) { setError(reason.message) }
  }

  const setDealValue = key => value => setDeal(current => ({ ...current, [key]:value }))
  const shownProjects = projects.filter(project => !projectSearch || project.title?.toLowerCase().includes(projectSearch.toLowerCase()))

  return <main className="analyze-page">
    <style>{ANALYZE_STYLES}</style>
    <div className="analyze-heading"><h1>Analyze</h1><p>Know what to pay, what to list for, and whether the flip is worth it.</p></div>
    {(notice || error) && <div className={`analyze-notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}
    <nav className="analyze-tool-nav" aria-label="Analyze tools">{ANALYZE_TOOLS.map(item => <button key={item.key} type="button" className={tool === item.key ? 'selected' : ''} aria-current={tool === item.key ? 'page' : undefined} onClick={() => setTool(item.key)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>

    {tool === 'deal' && <>
      <Hero eyebrow="PRIMARY TOOL" title="Deal Analyzer">Evaluate a potential flip before you buy it.</Hero>
      <button ref={pickerButton} className="analyze-project-button" type="button" onClick={() => setPickerOpen(true)}>🔎 Analyze Existing Project</button>
      <section className="analyze-card" aria-label="Deal details">
        <Field label="Item / Project Name" money={false} maximum={undefined} value={deal.itemName} onChange={setDealValue('itemName')} placeholder="What are you flipping?"/>
        {deal.projectId && <p className="analyze-private">Linked Project · values are a private analysis copy</p>}
        <h3>Investment</h3>
        {[['Purchase Price','purchasePrice'],['Estimated Repairs / Materials','repairsMaterials'],['Parts','parts'],['Fuel / Travel','fuelTravel'],['Shipping Cost','shippingCost'],['Other Expenses','otherExpenses']].map(([label,key]) => <MoneyField key={key} currency={currency} label={label} value={deal[key]} onChange={setDealValue(key)}/>)}
        <h3>Sale Estimate</h3>
        <MoneyField currency={currency} label="Expected Selling Price" value={deal.expectedSellingPrice} onChange={setDealValue('expectedSellingPrice')}/>
        <PlatformPicker preset={platform} setPreset={setPlatform} fee={deal.platformFeePct} setFee={setDealValue('platformFeePct')}/>
        <MoneyField currency={currency} label="Seller-Paid Shipping (optional)" value={deal.sellerPaidShipping} onChange={setDealValue('sellerPaidShipping')}/>
        <MoneyField currency={currency} label="Sales Tax / Other Selling Fees (optional)" value={deal.salesTaxOtherFees} onChange={setDealValue('salesTaxOtherFees')}/>
        <MoneyField currency={currency} label="Desired Minimum Profit" value={deal.desiredMinimumProfit} onChange={setDealValue('desiredMinimumProfit')}/>
        <p className="analyze-disclosure">Estimated resale values are entered by you. This field can later accept verified comparable-sales research without changing the calculation engine.</p>
      </section>
      {Number(deal.expectedSellingPrice) > 0 && <Results><Rating result={dealResult}/><div className="analyze-metrics">
        <Metric primary label="Expected Profit" value={money(dealResult.expectedProfit)} tone={dealResult.expectedProfit >= 0 ? 'positive' : 'negative'}/><Metric primary label="ROI" value={pct(dealResult.roiPct)} tone={dealResult.roiPct == null || dealResult.roiPct >= 0 ? 'positive' : 'negative'}/>
        <Metric label="Maximum Buy Price" value={money(dealResult.maximumPurchasePrice)}/><Metric label="Break-Even Price" value={money(dealResult.breakEvenSellingPrice)}/><Metric label="Total Investment" value={money(dealResult.totalInvestment)}/><Metric label="Expected Revenue" value={money(dealResult.expectedRevenue)}/><Metric label="Platform Fees" value={money(dealResult.platformFees)}/><Metric label="Total Selling Costs" value={money(dealResult.totalSellingCosts)}/><Metric label="Profit Margin" value={pct(dealResult.profitMarginPct)}/>
      </div><button className="btn btn-primary" type="button" disabled={saving} onClick={saveCurrentDeal}>{saving ? 'Saving…' : 'Save Analysis'}</button></Results>}
    </>}

    {tool === 'quick' && <><Hero eyebrow="UNDER 10 SECONDS" title="Quick Deal Check">Four numbers for a fast buy-or-pass decision.</Hero><section className="analyze-card">{[['Asking Price','askingPrice'],['Estimated Repairs','estimatedRepairs'],['Expected Resale Value','expectedResaleValue'],['Desired Minimum Profit','desiredMinimumProfit']].map(([label,key]) => <MoneyField key={key} currency={currency} label={label} value={quick[key]} onChange={value => setQuick(current => ({...current,[key]:value}))}/>)}</section>{Number(quick.expectedResaleValue) > 0 && <Results><Rating result={quickResult}/><div className="analyze-metrics"><Metric primary label="Expected Profit" value={money(quickResult.expectedProfit)} tone={quickResult.expectedProfit >= 0 ? 'positive' : 'negative'}/><Metric primary label="ROI" value={pct(quickResult.roiPct)}/><Metric label="Maximum Buy Price" value={money(quickResult.maximumBuyPrice)}/><Metric label="Expected Investment" value={money(quickResult.expectedInvestment)}/></div></Results>}</>}

    {tool === 'list' && <><Hero title="List Price Calculator">Set a profit target and account for selling costs.</Hero><section className="analyze-card"><MoneyField currency={currency} label="Total Invested" value={list.totalInvested} onChange={value => setList(current => ({...current,totalInvested:value}))}/><ChipGroup label="Desired Profit" options={[{key:'profit',label:'Profit Amount'},{key:'roi',label:'ROI %'}]} value={list.targetMode} onChange={mode => {setRoiPreset(mode === 'roi' ? '10' : 'custom');setList(current => ({...current,targetMode:mode,targetValue:mode === 'roi' ? '10' : ''}))}}/>{list.targetMode === 'roi' ? <><ChipGroup label="ROI Target" options={[...ROI_PRESETS.map(value => ({key:value,label:`${value}%`})),{key:'custom',label:'Custom'}]} value={roiPreset} onChange={value => {setRoiPreset(value);setList(current => ({...current,targetValue:value === 'custom' ? '' : value}))}}/>{roiPreset === 'custom' && <Field label="Custom ROI %" money={false} maximum={MAX_ROI_PERCENT} value={list.targetValue} onChange={value => setList(current => ({...current,targetValue:value}))} placeholder="Enter ROI percentage"/>}</> : <MoneyField currency={currency} label="Target Profit" value={list.targetValue} onChange={value => setList(current => ({...current,targetValue:value}))}/>}<PlatformPicker preset={listPlatform} setPreset={setListPlatform} fee={list.platformFeePct} setFee={value => setList(current => ({...current,platformFeePct:value}))}/>{[['Seller-Paid Shipping','sellerPaidShipping'],['Additional Selling Costs','additionalSellingCosts']].map(([label,key]) => <MoneyField key={key} currency={currency} label={label} value={list[key]} onChange={value => setList(current => ({...current,[key]:value}))}/>)}</section>{Number(list.totalInvested) > 0 && <Results><div className="analyze-metrics"><Metric primary label="Recommended List Price" value={money(listResult.recommendedListPrice)} tone="positive"/><Metric primary label="Suggested Minimum Offer" value={money(listResult.suggestedMinimumOffer)}/><Metric label="Expected Profit" value={money(listResult.expectedProfit)} tone="positive"/><Metric label="Expected ROI" value={pct(listResult.expectedRoiPct)} tone="positive"/><Metric label="Break-Even Price" value={money(listResult.breakEvenPrice)}/></div><p className="analyze-result-note">{listResult.minimumOfferBasis === 'negotiation_floor' ? 'The suggested minimum is a negotiation floor at 92% of list price.' : 'Break-even is higher than 92% of list price, so the suggested minimum was raised to avoid a projected loss.'} At that price, projected profit is {money(listResult.minimumOfferExpectedProfit)} ({pct(listResult.minimumOfferExpectedRoiPct)} ROI), which is {listResult.minimumOfferTargetComparison} your target.</p></Results>}</>}

    {tool === 'max' && <><Hero title="Maximum Buy Price">Work backward from resale value and your minimum profit.</Hero><section className="analyze-card">{[['Expected Resale Value','expectedSellingPrice'],['Estimated Expenses (excluding purchase)','nonPurchaseExpenses'],['Desired Minimum Profit','desiredMinimumProfit']].map(([label,key]) => <MoneyField key={key} currency={currency} label={label} value={maxBuy[key]} onChange={value => setMaxBuy(current => ({...current,[key]:value}))}/>)}<PlatformPicker preset={maxPlatform} setPreset={setMaxPlatform} fee={maxBuy.platformFeePct} setFee={value => setMaxBuy(current => ({...current,platformFeePct:value}))}/>{[['Seller-Paid Shipping','sellerPaidShipping'],['Other Selling Costs','otherSellingCosts']].map(([label,key]) => <MoneyField key={key} currency={currency} label={label} value={maxBuy[key]} onChange={value => setMaxBuy(current => ({...current,[key]:value}))}/>)}</section>{Number(maxBuy.expectedSellingPrice) > 0 && <Results><div className="analyze-metrics"><Metric primary label={maxResult.feasible ? 'Maximum Buy Price' : 'No Feasible Buy Price'} value={money(maxResult.maximumPurchasePrice)} tone={maxResult.feasible ? 'positive' : 'negative'}/><Metric label="Platform Fees" value={money(maxResult.platformFees)}/><Metric label="Total Selling Costs" value={money(maxResult.totalSellingCosts)}/></div>{!maxResult.feasible && <p className="analyze-result-note">Even a free purchase would not meet the selected profit target after expenses and selling costs.</p>}</Results>}</>}

    {tool === 'profit' && <><Hero title="Profit Calculator">See the bottom line after every selling cost.</Hero><section className="analyze-card">{[['Total Invested','totalInvested'],['Selling Price','sellingPrice']].map(([label,key]) => <MoneyField key={key} currency={currency} label={label} value={profit[key]} onChange={value => setProfit(current => ({...current,[key]:value}))}/>)}<PlatformPicker preset={profitPlatform} setPreset={setProfitPlatform} fee={profit.platformFeePct} setFee={value => setProfit(current => ({...current,platformFeePct:value}))}/>{[['Seller-Paid Shipping','sellerPaidShipping'],['Additional Selling Costs','additionalSellingCosts']].map(([label,key]) => <MoneyField key={key} currency={currency} label={label} value={profit[key]} onChange={value => setProfit(current => ({...current,[key]:value}))}/>)}</section>{Number(profit.sellingPrice) > 0 && <Results><div className="analyze-metrics"><Metric primary label="Expected Profit" value={money(profitResult.expectedProfit)} tone={profitResult.expectedProfit >= 0 ? 'positive' : 'negative'}/><Metric primary label="ROI" value={pct(profitResult.roiPct)}/><Metric label="Profit Margin" value={pct(profitResult.profitMarginPct)}/><Metric label="Break-Even Price" value={money(profitResult.breakEvenPrice)}/><Metric label="Platform Fees" value={money(profitResult.platformFees)}/><Metric label="Total Selling Costs" value={money(profitResult.totalSellingCosts)}/></div></Results>}</>}

    {saved.length > 0 && <section className="analyze-card analyze-saved"><h2>Saved Analyses on This Device</h2>{saved.map(record => <article key={record.id}><button type="button" aria-label={`Load ${record.itemName} analysis`} onClick={() => loadAnalysis(record)}><strong>{record.itemName}</strong><span>{moneyFormatter(record.currency)(record.projectedProfit)} profit · {pct(record.projectedRoi)} ROI · {new Date(record.analyzedAt).toLocaleDateString()}</span></button><button type="button" className="delete" aria-label={`Delete ${record.itemName} analysis`} onClick={() => removeAnalysis(record)}>Delete</button></article>)}</section>}

    {pickerOpen && <div className="analyze-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPickerOpen(false) }}><section ref={pickerDialog} className="analyze-modal" role="dialog" aria-modal="true" aria-labelledby="project-picker-title"><header><h2 id="project-picker-title">Analyze Existing Project</h2><button type="button" aria-label="Close Project picker" onClick={() => setPickerOpen(false)}>Done</button></header><label htmlFor="analyze-project-search">Search Projects</label><input id="analyze-project-search" type="search" value={projectSearch} onChange={event => setProjectSearch(event.target.value)} placeholder="Search projects" autoFocus/><div className="analyze-project-list">{shownProjects.map(project => {const draft=projectAnalysisDraft(project);return <button type="button" key={project.id} aria-label={`Analyze ${project.title}`} onClick={() => applyProject(project)}><span><strong>{project.title}</strong><small>{project.status === 'sold' ? 'Sold' : 'Active'} · {money(draft.totalInvested)} invested</small></span><b aria-hidden="true">›</b></button>})}{shownProjects.length === 0 && <p>No matching projects.</p>}</div></section></div>}
  </main>
}
