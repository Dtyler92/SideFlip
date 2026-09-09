import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { createGoal, updateGoal, deleteGoal, adjustGoalBalance, linkProjectToGoal, recordDirectTrade } from '../db'
import { calculateGoalSummary, calculateProjectLinkFunding, canCompleteGoal, createMutationId, isGoalLockedAfterProLoss, progressColor, shouldShowGoalOnboarding, validateGoalDraft } from '../goals'
import { canCreateGoal, getPlan } from '../capabilities'
import { CATEGORIES, fmt, categoryIcon, getTotalInvested, getProfit } from '../store'
import { captureEvent } from '../analytics'
import UpgradePrompt from '../components/UpgradePrompt'

const newGoalForm = () => ({ name: '', goalType: 'item', targetItem: '', targetAmount: '', startingAmount: '', description: '', mutationId: createMutationId() })
const newTradeForm = () => ({
  outgoingId: '', incomingTitle: '', category: 'other', tradeCredit: '',
  cashDirection: 'none', cashAmount: '', goalCashAmount: '', keepCashAmount: '', notes: '', mutationId: createMutationId()
})
const newAdjustment = () => ({ type: 'personal_contribution', amount: '', note: '', mutationId: createMutationId() })
const newProjectLink = () => ({ projectId: '', goalFundingAmount: '', mutationId: createMutationId() })

export default function Goals() {
  const navigate = useNavigate()
  const { user, profile, entitlement } = useAuth()
  const { goals, projects, refresh } = useData()
  const plan = getPlan(profile, entitlement)
  const canCreateAnotherGoal = canCreateGoal(profile, entitlement, goals)
  const [selectedId, setSelectedId] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showAddProject, setShowAddProject] = useState(false)
  const [showTrade, setShowTrade] = useState(false)
  const [goalForm, setGoalForm] = useState(newGoalForm)
  const [tradeForm, setTradeForm] = useState(newTradeForm)
  const [adjustment, setAdjustment] = useState(newAdjustment)
  const [projectLink, setProjectLink] = useState(newProjectLink)
  const [showTargetEditor, setShowTargetEditor] = useState(false)
  const [targetAmountInput, setTargetAmountInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [upgradeMessage, setUpgradeMessage] = useState('')

  const selectedCandidate = goals.find(goal => goal.id === selectedId)
  const selected = selectedCandidate && !isGoalLockedAfterProLoss(selectedCandidate, goals, plan) ? selectedCandidate : null
  const goalProjects = useMemo(
    () => selected ? projects.filter(project => project.goalId === selected.id) : [],
    [selected, projects]
  )
  const summary = selected ? calculateGoalSummary(selected, projects, selected.ledger) : null
  const activeProjects = goalProjects.filter(project => project.status === 'active')
  const soldProjects = goalProjects.filter(project => project.status === 'sold')
  const availableProjects = projects.filter(project => project.status === 'active' && !project.goalId && !project.tradedFromProjectId)
  const selectedProjectToLink = availableProjects.find(project => project.id === projectLink.projectId)
  const adjustmentAmount = Number(adjustment.amount) || 0
  const adjustmentIsValid = adjustmentAmount > 0 && (adjustment.type !== 'cash_out' || adjustmentAmount <= (summary?.available || 0))
  const availableAfterAdjustment = summary
    ? summary.available + (adjustment.type === 'cash_out' ? -adjustmentAmount : adjustmentAmount)
    : 0

  function closeSelectedGoal() {
    setSelectedId(null)
    setShowAddProject(false)
    setShowTrade(false)
    setShowTargetEditor(false)
    setTargetAmountInput('')
    setProjectLink(newProjectLink())
  }

  function getCurrentlyAccessibleGoal(goalId = selectedId) {
    const goal = goals.find(candidate => candidate.id === goalId)
    if (!goal || isGoalLockedAfterProLoss(goal, goals, plan)) {
      closeSelectedGoal()
      setUpgradeMessage('Your plan changed. Only your oldest active Trade-Up Goal is available without SideFlip Pro.')
      return null
    }
    return goal
  }

  async function handleCreate(event) {
    event.preventDefault()
    if (!canCreateGoal(profile, entitlement, goals)) return setUpgradeMessage('Free includes one active Trade-Up Goal. Upgrade to SideFlip Pro to create another.')
    try { validateGoalDraft(goalForm) } catch (error) { return alert(error.message) }
    setSaving(true)
    try {
      const created = await createGoal(user.id, goalForm)
      captureEvent('goal_created', { goal_type: goalForm.goalType })
      await refresh()
      setGoalForm(newGoalForm())
      setShowCreate(false)
      setSelectedId(created.id)
    } catch (error) {
      alert('Could not create goal: ' + error.message)
    } finally { setSaving(false) }
  }

  async function handleAdjustment(event) {
    event.preventDefault()
    const mutationGoal = getCurrentlyAccessibleGoal()
    if (!mutationGoal) return
    const amount = Number(adjustment.amount)
    const mutationSummary = calculateGoalSummary(mutationGoal, projects, mutationGoal.ledger)
    if (!Number.isFinite(amount) || amount <= 0) return alert('Enter a finite amount greater than zero')
    if (adjustment.type === 'cash_out' && amount > mutationSummary.available) return alert('That is more than the amount currently available toward this goal')
    setSaving(true)
    try {
      await adjustGoalBalance(mutationGoal.id, adjustment.type, amount,
        adjustment.note || (adjustment.type === 'cash_out' ? 'Taken out of goal' : 'Added toward goal'),
        adjustment.mutationId)
      await refresh()
      setAdjustment(newAdjustment())
    } catch (error) { alert('Could not update goal: ' + error.message) }
    finally { setSaving(false) }
  }

  async function handleLinkProject(event) {
    event.preventDefault()
    const mutationGoal = getCurrentlyAccessibleGoal()
    if (!mutationGoal) return
    if (!selectedProjectToLink) return alert('Choose a current project to add')
    const mutationSummary = calculateGoalSummary(mutationGoal, projects, mutationGoal.ledger)
    let funding
    try {
      funding = calculateProjectLinkFunding(
        selectedProjectToLink.purchasePrice,
        projectLink.goalFundingAmount,
        mutationSummary.available,
      )
    } catch (error) {
      return alert(error.message)
    }
    setSaving(true)
    try {
      await linkProjectToGoal(
        user.id,
        selectedProjectToLink.id,
        mutationGoal.id,
        funding.goalFundingAmount,
        projectLink.mutationId,
      )
      await refresh()
      setProjectLink(newProjectLink())
      setShowAddProject(false)
    } catch (error) {
      alert('Could not add project to goal: ' + error.message)
    } finally { setSaving(false) }
  }

  async function handleTrade(event) {
    event.preventDefault()
    const mutationGoal = getCurrentlyAccessibleGoal()
    if (!mutationGoal) return
    const mutationSummary = calculateGoalSummary(mutationGoal, projects, mutationGoal.ledger)
    const outgoing = activeProjects.find(project => project.id === tradeForm.outgoingId)
    const tradeCredit = Number(tradeForm.tradeCredit)
    const cash = tradeForm.cashDirection === 'none' ? 0 : Number(tradeForm.cashAmount)
    const goalCash = tradeForm.cashDirection === 'paid' ? Number(tradeForm.goalCashAmount || 0) : 0
    const keepCash = tradeForm.cashDirection === 'received' ? Number(tradeForm.keepCashAmount || 0) : 0
    if (!outgoing) return alert('Select the item you are trading away')
    if (!tradeForm.incomingTitle.trim()) return alert('Name the item you are receiving')
    if (!Number.isFinite(tradeCredit) || tradeCredit <= 0) return alert('Enter a finite agreed value greater than zero')
    if (tradeForm.cashDirection !== 'none' && (!Number.isFinite(cash) || cash <= 0)) return alert('Enter a finite cash difference greater than zero')
    if (![goalCash, keepCash].every(value => Number.isFinite(value) && value >= 0)) return alert('Trade amounts must be finite and nonnegative')
    if (tradeForm.cashDirection === 'received' && tradeForm.keepCashAmount.trim() === '') return alert('Enter how much cash should remain toward the goal, including zero')
    if (goalCash > cash || goalCash > mutationSummary.available) return alert('Goal funds used cannot exceed the cash paid or amount available')
    if (keepCash > cash) return alert('Amount kept in the goal cannot exceed cash received')
    setSaving(true)
    try {
      await recordDirectTrade(user.id, outgoing, tradeForm)
      await refresh()
      setTradeForm(newTradeForm())
      setShowTrade(false)
    } catch (error) { alert('Could not record trade: ' + error.message) }
    finally { setSaving(false) }
  }

  async function setGoalStatus(status) {
    if (saving) return
    const mutationGoal = getCurrentlyAccessibleGoal()
    if (!mutationGoal) return
    const verb = status === 'completed' ? 'complete' : 'reopen'
    const mutationSummary = calculateGoalSummary(mutationGoal, projects, mutationGoal.ledger)
    if (status === 'completed' && !canCompleteGoal(mutationGoal, mutationSummary)) {
      const remaining = Math.max(0, Number(mutationGoal.targetAmount || 0) - mutationSummary.progressValue)
      return alert(`Current progress must fully fund the positive target before completion. ${fmt(remaining)} remains.`)
    }
    if (!confirm(`${status === 'completed' ? 'Mark' : 'Reopen'} this Trade-Up Goal?`)) return
    setSaving(true)
    try {
      await updateGoal(user.id, mutationGoal.id, {
        status,
        completedAt: status === 'completed' ? new Date().toISOString() : null,
      })
      if (status === 'completed') captureEvent('goal_completed', { goal_type: mutationGoal.goalType })
      await refresh()
    } catch (error) {
      alert(`Could not ${verb} goal: ${error.message}`)
    } finally { setSaving(false) }
  }

  async function saveTargetAmount(event) {
    event.preventDefault()
    const mutationGoal = getCurrentlyAccessibleGoal()
    if (!mutationGoal) return
    const targetAmount = Number(targetAmountInput)
    if (!Number.isFinite(targetAmount) || targetAmount <= 0) return alert('Enter a finite target amount greater than zero')
    setSaving(true)
    try {
      await updateGoal(user.id, mutationGoal.id, { targetAmount })
      setShowTargetEditor(false)
      setTargetAmountInput('')
      await refresh()
    } catch (error) {
      alert('Could not update target: ' + error.message)
    } finally { setSaving(false) }
  }

  async function removeGoal() {
    if (saving) return
    const mutationGoal = getCurrentlyAccessibleGoal()
    if (!mutationGoal || !confirm('Delete this goal? Linked projects will remain in SideFlip but will no longer belong to the goal.')) return
    setSaving(true)
    try {
      await deleteGoal(user.id, mutationGoal.id)
      setSelectedId(null)
      await refresh()
    } catch (error) {
      alert('Could not delete goal: ' + error.message)
    } finally { setSaving(false) }
  }

  if (selected) return (
    <>
      <div className="page-header">
        <button className="back-btn" onClick={() => { setSelectedId(null); setShowAddProject(false); setShowTrade(false); setProjectLink(newProjectLink()) }}>‹</button>
        <h1 style={{ flex: 1 }}>{selected.name}</h1>
      </div>
      <div className="page" style={{ paddingBottom: 110 }}>
        <div className="card" style={{ marginBottom: 14, ...(canCompleteGoal(selected, summary) ? reachedGoalCard : {}) }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div>
              <div style={eyebrow}>{selected.goalType === 'item' ? 'Target item' : 'Target amount'}</div>
              <div style={{ fontSize: 20, fontWeight: 800 }}>{selected.goalType === 'item' ? selected.targetItem : fmt(selected.targetAmount)}</div>
              {selected.goalType === 'item' && Number(selected.targetAmount) > 0 && <div style={{ color: 'var(--muted)', marginTop: 3 }}>Estimated target: {fmt(selected.targetAmount)}</div>}
            </div>
            <span style={{ ...statusPill, background: selected.status === 'completed' ? '#D8F3DC' : '#FDF1EF', color: selected.status === 'completed' ? '#2D6A4F' : 'var(--accent)' }}>{selected.status}</span>
          </div>
          {Number(selected.targetAmount) > 0 && <>
            <div style={{ height: 10, borderRadius: 999, background: '#EEEAE3', overflow: 'hidden', marginTop: 18 }}>
              <div style={{ height: '100%', width: `${summary.progressPercent}%`, background: progressColor(summary.progressPercent), borderRadius: 999 }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, fontSize: 12, color: 'var(--muted)' }}>
              <span>{fmt(summary.progressValue)} toward goal</span><strong>{summary.progressPercent}%</strong>
            </div>
          </>}
          {selected.description && <div style={{ color: 'var(--text)', marginTop: 14, lineHeight: 1.5 }}>{selected.description}</div>}
          {canCompleteGoal(selected, summary) && (
            <div aria-live="polite" role="status" style={reachedNotice}>
              <strong>🎉 Target reached!</strong>
              <span>You fully funded {selected.name}. You can mark this goal complete when you are ready.</span>
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 14, lineHeight: 1.5 }}>SideFlip tracks these amounts for your records. SideFlip does not hold, transfer, or process money from item sales.</div>
        </div>

        <div style={statGrid}>
          <Stat label="Current Progress" value={fmt(summary.progressValue)} />
          <Stat label="Current Goal Capital" value={fmt(summary.currentGoalCapital)} />
          <Stat label="Available Toward Goal" value={fmt(summary.available)} />
          <Stat label="In Active Items" value={fmt(summary.activeValue)} />
          <Stat label="Out of Pocket" value={fmt(summary.outOfPocket)} />
          <Stat label="Gross Flipped" value={fmt(summary.grossFlipped)} />
          <Stat label="Personal Cash Invested" value={fmt(summary.personalCashInvested)} />
          <Stat label="Proceeds Reinvested" value={fmt(summary.proceedsReinvested)} />
          <Stat label="Total Project Expenses" value={fmt(summary.totalProjectExpenses)} />
          <Stat label="Realized Profit" value={fmt(summary.realizedProfit)} green={summary.realizedProfit >= 0} />
          <Stat label="Taken Out" value={fmt(summary.takenOut)} />
          <Stat label="Completed Steps" value={summary.soldCount} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Personal cash is counted once. Reused sale proceeds never increase Personal Cash Invested.</div>

        {selected.status === 'active' && <>
        <div className="card" style={{ marginBottom: 14 }}>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ margin: 0 }}
            aria-expanded={showTargetEditor}
            onClick={() => {
              setTargetAmountInput(String(selected.targetAmount || ''))
              setShowTargetEditor(value => !value)
            }}
          >
            {showTargetEditor ? 'Cancel Target Edit' : 'Change Target Amount'}
          </button>
          {showTargetEditor && (
            <form onSubmit={saveTargetAmount} style={{ marginTop: 14 }}>
              <Field label={selected.goalType === 'item' ? 'Estimated target value' : 'Target amount'}>
                <MoneyInput value={targetAmountInput} onChange={setTargetAmountInput} />
              </Field>
              <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Target Amount'}</button>
            </form>
          )}
        </div>
        <div style={actionRow}>
          <button className="btn btn-primary" style={{ margin: 0 }} onClick={() => { setShowAddProject(value => !value); setShowTrade(false) }}>{showAddProject ? 'Close Add Project' : '+ Add Project'}</button>
          <button className="btn btn-secondary" style={{ margin: 0 }} onClick={() => { setShowTrade(value => !value); setShowAddProject(false) }} disabled={!activeProjects.length}>⇄ Record Trade</button>
        </div>

        {showAddProject && <form onSubmit={handleLinkProject} className="card" style={{ marginTop: 14 }}>
          <h3 style={sectionTitle}>Add a Project</h3>
          <button type="button" className="btn btn-secondary" style={{ marginTop: 0 }} onClick={() => navigate(`/new?goal=${selected.id}`)}>+ Create New Project</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0', color: 'var(--muted)', fontSize: 11 }}><span style={{ height: 1, background: 'var(--border)', flex: 1 }} /><span>OR CHOOSE FROM PROJECTS</span><span style={{ height: 1, background: 'var(--border)', flex: 1 }} /></div>
          {availableProjects.length === 0
            ? <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>No unlinked active projects are available. Create a new project or reopen one from the Projects tab.</div>
            : <>
              <Field label="Current project">
                <select value={projectLink.projectId} onChange={event => setProjectLink({ projectId: event.target.value, goalFundingAmount: '', mutationId: createMutationId() })}>
                  <option value="">Select a project</option>
                  {availableProjects.map(project => <option key={project.id} value={project.id}>{project.title} · {fmt(project.purchasePrice)}</option>)}
                </select>
              </Field>
              {selectedProjectToLink && <>
                <div style={{ background: '#F7F4EE', borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 13 }}>
                  <strong>{selectedProjectToLink.title}</strong>
                  <div style={{ color: 'var(--muted)', marginTop: 4 }}>Original purchase: {fmt(selectedProjectToLink.purchasePrice)} · Expenses: {fmt((selectedProjectToLink.expenses || []).reduce((sum, expense) => sum + Number(expense.amount || 0), 0))}</div>
                </div>
                <Field label={`Use from goal (available ${fmt(summary.available)})`}>
                  <MoneyInput value={projectLink.goalFundingAmount} onChange={goalFundingAmount => setProjectLink(value => ({ ...value, goalFundingAmount }))} />
                </Field>
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: -4, marginBottom: 12 }}>Personal contribution: {fmt(Math.max(0, Number(selectedProjectToLink.purchasePrice || 0) - Number(projectLink.goalFundingAmount || 0)))}</div>
              </>}
              <button className="btn btn-primary" disabled={saving || !selectedProjectToLink}>{saving ? 'Adding…' : 'Add Selected Project'}</button>
            </>}
        </form>}

        {showTrade && <form onSubmit={handleTrade} className="card" style={{ marginTop: 14 }}>
          <h3 style={sectionTitle}>Record a Direct Trade</h3>
          <Field label="Item traded away"><select value={tradeForm.outgoingId} onChange={e => setTradeForm(f => ({ ...f, outgoingId: e.target.value }))}><option value="">Select an active item</option>{activeProjects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></Field>
          <Field label="Item received"><input value={tradeForm.incomingTitle} onChange={e => setTradeForm(f => ({ ...f, incomingTitle: e.target.value }))} placeholder="e.g. 2012 Honda ATV" /></Field>
          <Field label="Category"><select value={tradeForm.category} onChange={e => setTradeForm(f => ({ ...f, category: e.target.value }))}>{CATEGORIES.map(category => <option key={category.value} value={category.value}>{category.label}</option>)}</select></Field>
          <Field label="Agreed value of item traded away"><MoneyInput value={tradeForm.tradeCredit} onChange={value => setTradeForm(f => ({ ...f, tradeCredit: value }))} /></Field>
          <Field label="Cash difference"><select value={tradeForm.cashDirection} onChange={e => setTradeForm(f => ({ ...f, cashDirection: e.target.value, cashAmount: '', goalCashAmount: '', keepCashAmount: '' }))}><option value="none">No cash difference</option><option value="paid">I paid additional cash</option><option value="received">I received additional cash</option></select></Field>
          {tradeForm.cashDirection !== 'none' && <Field label="Cash amount"><MoneyInput value={tradeForm.cashAmount} onChange={value => setTradeForm(f => ({ ...f, cashAmount: value }))} /></Field>}
          {tradeForm.cashDirection === 'paid' && <Field label={`Use from goal (available ${fmt(summary.available)})`}><MoneyInput value={tradeForm.goalCashAmount} onChange={value => setTradeForm(f => ({ ...f, goalCashAmount: value }))} /></Field>}
          {tradeForm.cashDirection === 'received' && <Field label="Keep this much toward the goal"><MoneyInput value={tradeForm.keepCashAmount} onChange={value => setTradeForm(f => ({ ...f, keepCashAmount: value }))} /></Field>}
          <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Record Trade'}</button>
        </form>}

        <form onSubmit={handleAdjustment} className="card" style={{ marginTop: 14, padding: 18 }}>
          <div style={{ ...eyebrow, color: 'var(--accent)', marginBottom: 6 }}>Goal funds · Tracking only</div>
          <h3 style={{ fontSize: 19, margin: '0 0 5px', color: 'var(--text)' }}>Update Available Amount</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, margin: '0 0 16px' }}>Record personal money added to this goal or money you have taken out.</p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginBottom: 16 }} role="group" aria-label="Update type">
            <button type="button" onClick={() => setAdjustment(value => ({ ...value, type: 'personal_contribution' }))} style={adjustmentChoice(adjustment.type === 'personal_contribution')}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>Add Money</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>Personal contribution</span>
            </button>
            <button type="button" onClick={() => setAdjustment(value => ({ ...value, type: 'cash_out' }))} style={adjustmentChoice(adjustment.type === 'cash_out')}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>Take Money Out</span>
              <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>Reduce available funds</span>
            </button>
          </div>

          <Field label="Amount">
            <MoneyInput value={adjustment.amount} onChange={amount => setAdjustment(value => ({ ...value, amount }))} />
          </Field>
          {adjustment.type === 'cash_out' && adjustmentAmount > summary.available && <div style={{ color: 'var(--accent)', fontSize: 12, marginTop: -10, marginBottom: 14 }}>Enter no more than {fmt(summary.available)}, the amount currently available.</div>}
          <Field label="Note (optional)">
            <input value={adjustment.note} onChange={e => setAdjustment(value => ({ ...value, note: e.target.value }))} placeholder={adjustment.type === 'cash_out' ? 'e.g. Set aside for another purchase' : 'e.g. Added from this week’s budget'} />
          </Field>

          <div style={{ background: '#F7F4EE', border: '1px solid var(--border)', borderRadius: 11, padding: '11px 13px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 600 }}>Available after update</span>
            <strong style={{ fontSize: 17 }}>{fmt(Math.max(0, availableAfterAdjustment))}</strong>
          </div>
          <button className="btn btn-primary" disabled={saving || !adjustmentIsValid}>{saving ? 'Saving…' : adjustment.type === 'cash_out' ? 'Take Money Out' : 'Add to Goal'}</button>
        </form>
        </>}

        <ProjectSection title={`Active Items (${activeProjects.length})`} projects={activeProjects} navigate={navigate} />
        <ProjectSection title={`Completed Steps (${soldProjects.length})`} projects={soldProjects} navigate={navigate} />

        {selected.status === 'active' && canCompleteGoal(selected, summary)
          ? <button className="btn btn-green" disabled={saving} onClick={() => setGoalStatus('completed')}>Mark Goal Complete</button>
          : selected.status === 'active'
            ? <div style={completionHint}>Goal completion unlocks when current progress reaches {fmt(selected.targetAmount)}. {fmt(Math.max(0, Number(selected.targetAmount) - summary.progressValue))} to go.</div>
          : <button className="btn btn-green" disabled={saving} onClick={() => setGoalStatus('active')}>↻ Reopen Goal</button>}
        <button className="btn btn-secondary" disabled={saving} style={{ color: 'var(--accent)' }} onClick={removeGoal}>Delete Goal</button>
      </div>
    </>
  )

  return (
    <>
      <div className="page-header"><h1 style={{ flex: 1 }}>Trade-Up Goals</h1></div>
      <div className="page" style={{ paddingBottom: 110 }}>
        {shouldShowGoalOnboarding(goals) && (
          <div className="card" style={{ marginBottom: 16, background: '#1A1917', color: '#fff' }}>
            <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Start with what you have.</div>
            <div style={{ color: '#D4CDC1', lineHeight: 1.55 }}>Connect multiple projects and track every step toward an item or dollar goal.</div>
          </div>
        )}
        {canCreateAnotherGoal ? (
          <button className="btn btn-primary" onClick={() => setShowCreate(value => !value)}>{showCreate ? 'Cancel' : '+ Create a Goal'}</button>
        ) : (
          <div className="card" style={{ marginBottom: 16, background: '#FDF1EF' }}>
            <div style={{ fontSize: 11, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, marginBottom: 6 }}>SideFlip Pro</div>
            <strong>Free includes one Trade-Up Goal.</strong>
            <div style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, marginTop: 5 }}>Upgrade to Pro to track additional goals at the same time.</div>
            <button type="button" className="btn btn-secondary" onClick={() => setUpgradeMessage('Upgrade to SideFlip Pro to create and manage additional Trade-Up Goals.')}>View SideFlip Pro</button>
          </div>
        )}
        {showCreate && canCreateAnotherGoal && <form onSubmit={handleCreate} className="card" style={{ marginBottom: 16 }}>
          <Field label="Goal name"><input value={goalForm.name} onChange={e => setGoalForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Trade up to my dream truck" /></Field>
          <Field label="Goal type"><select value={goalForm.goalType} onChange={e => setGoalForm(f => ({ ...f, goalType: e.target.value }))}><option value="item">Specific item</option><option value="amount">Dollar amount</option></select></Field>
          {goalForm.goalType === 'item' && <Field label="Item you want"><input value={goalForm.targetItem} onChange={e => setGoalForm(f => ({ ...f, targetItem: e.target.value }))} placeholder="e.g. Ford F-250" /></Field>}
          <Field label={goalForm.goalType === 'item' ? 'Estimated target value' : 'Target amount'}><MoneyInput value={goalForm.targetAmount} onChange={value => setGoalForm(f => ({ ...f, targetAmount: value }))} /></Field>
          <Field label="Starting amount toward goal (optional)"><MoneyInput value={goalForm.startingAmount} onChange={value => setGoalForm(f => ({ ...f, startingAmount: value }))} /></Field>
          <Field label="Notes (optional)"><textarea value={goalForm.description} onChange={e => setGoalForm(f => ({ ...f, description: e.target.value }))} placeholder="Why this goal matters…" /></Field>
          <button className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create Trade-Up Goal'}</button>
        </form>}

        {goals.length === 0 ? <div className="empty"><div className="empty-icon">🎯</div><h3>No Trade-Up Goals yet</h3><p>Create as many goals as you need and connect multiple projects to each one.</p></div> : goals.map(goal => {
          const goalSummary = calculateGoalSummary(goal, projects, goal.ledger)
          const locked = isGoalLockedAfterProLoss(goal, goals, plan)
          const reachedTarget = canCompleteGoal(goal, goalSummary)
          const content = <>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><div><div style={eyebrow}>{goal.goalType === 'item' ? goal.targetItem : 'Amount goal'}</div><div style={{ fontSize: 18, fontWeight: 800 }}>{goal.name}</div></div><span style={statusPill}>{goal.status}</span></div>
            {Number(goal.targetAmount) > 0 && <><div style={{ height: 7, background: locked ? '#D9D6CF' : '#EEEAE3', borderRadius: 999, marginTop: 14, overflow: 'hidden' }}><div style={{ height: '100%', width: `${goalSummary.progressPercent}%`, background: locked ? '#A8A49E' : progressColor(goalSummary.progressPercent) }} /></div><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', marginTop: 6 }}><span>{fmt(goalSummary.progressValue)} of {fmt(goal.targetAmount)}</span><strong>{goalSummary.progressPercent}%</strong></div></>}
            {!locked && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>{goalSummary.activeCount} active item{goalSummary.activeCount === 1 ? '' : 's'} · {goalSummary.soldCount} completed step{goalSummary.soldCount === 1 ? '' : 's'}</div>}
            {locked && <div style={lockedNotice}><strong>SideFlip Pro required</strong><span>Upgrade to unlock this goal and continue managing it.</span></div>}
          </>
          const cardStyle = { width: '100%', textAlign: 'left', marginBottom: 10, ...(reachedTarget ? reachedGoalCard : {}), ...(locked ? lockedGoalCard : {}) }
          return locked
            ? <button type="button" key={goal.id} className="card" aria-disabled="true" onClick={() => setUpgradeMessage('This goal is safely preserved. Upgrade to SideFlip Pro to open and continue managing it.')} style={{ ...cardStyle, cursor:'pointer' }}>{content}</button>
            : <button key={goal.id} onClick={() => setSelectedId(goal.id)} className="card" style={{ ...cardStyle, border: reachedTarget ? reachedGoalCard.border : 'none', cursor: 'pointer' }}>{content}</button>
        })}
        <UpgradePrompt open={Boolean(upgradeMessage)} message={upgradeMessage} onDismiss={() => setUpgradeMessage('')} />
      </div>
    </>
  )
}

function Stat({ label, value, green }) { return <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 12, padding: 13 }}><div style={eyebrow}>{label}</div><div style={{ fontSize: 17, fontWeight: 800, color: green ? '#2D6A4F' : 'var(--text)' }}>{value}</div></div> }
function Field({ label, children }) { return <div className="form-group"><label>{label}</label>{children}</div> }
function MoneyInput({ value, onChange }) { return <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" value={value} onChange={e => onChange(e.target.value)} /> }
function ProjectSection({ title, projects, navigate }) { return <section style={{ marginTop: 22 }}><h3 style={sectionTitle}>{title}</h3>{projects.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Nothing here yet.</div> : projects.map(project => <button key={project.id} className="card" onClick={() => navigate(`/project/${project.id}`)} style={{ width: '100%', border: 'none', display: 'flex', alignItems: 'center', textAlign: 'left', marginBottom: 8, cursor: 'pointer' }}><div style={{ fontSize: 28, marginRight: 12 }}>{categoryIcon(project.category)}</div><div style={{ flex: 1 }}><strong>{project.title}</strong><div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>{fmt(getTotalInvested(project))} invested{project.status === 'sold' ? ` · ${fmt(getProfit(project))} profit` : ''}</div></div><span style={{ color: '#D4CDC1', fontSize: 20 }}>›</span></button>)}</section> }

const eyebrow = { fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 700, marginBottom: 4 }
const statusPill = { borderRadius: 999, padding: '4px 9px', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', background: '#FDF1EF', color: 'var(--accent)', whiteSpace: 'nowrap' }
const statGrid = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginBottom: 14 }
const actionRow = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }
const sectionTitle = { fontSize: 15, margin: '0 0 10px', color: 'var(--text)' }
const reachedGoalCard = { background: '#DDF3E7', border: '2px solid #2D7A4F' }
const reachedNotice = { display: 'flex', flexDirection: 'column', gap: 4, color: '#315942', background: '#E8F5EE', borderRadius: 10, padding: 12, marginTop: 14, fontSize: 13 }
const completionHint = { color: 'var(--muted)', background: '#F2F0EB', borderRadius: 12, padding: 14, marginTop: 22, fontSize: 13, lineHeight: 1.5, textAlign: 'center' }
const lockedGoalCard = { background: '#EFEEE9', border: '1px solid #D4D0C8', opacity: 0.82 }
const lockedNotice = { borderTop: '1px solid #D4D0C8', marginTop: 14, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 3, color: '#5C5850', fontSize: 12 }
const adjustmentChoice = selected => ({
  minHeight: 66,
  padding: '10px 8px',
  borderRadius: 11,
  border: selected ? '2px solid var(--accent)' : '1px solid var(--border)',
  background: selected ? '#FDF1EF' : '#fff',
  color: selected ? 'var(--accent)' : 'var(--text)',
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
})
