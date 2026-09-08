import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CATEGORIES, getExtraFields, fmt } from '../store'
import { createProject } from '../db'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { accessibleActiveGoalsAfterProLoss, calculateGoalSummary, createMutationId } from '../goals'
import { getPlan } from '../capabilities'
import ProjectPhotoGallery from '../components/ProjectPhotoGallery'
import { captureEvent } from '../analytics'
import VinDecodePanel from '../components/VinDecodePanel'

export default function NewProject() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, profile, entitlement } = useAuth()
  const { refresh, goals, projects } = useData()
  const [photos, setPhotos] = useState([])
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    title: '', category: '', purchasePrice: '', notes: '',
    modelNumber: '', serialNumber: '',
    engineModel: '', engineSerial: '',
    vin: '', hullNumber: '', vehicleYear: '', vehicleMake: '', vehicleModel: '', transmission: '',
    goalId: searchParams.get('goal') || '', goalFundingAmount: '', mutationId: createMutationId(),
  })

  const fields = getExtraFields(form.category)
  const plan = getPlan(profile, entitlement)
  const activeGoals = accessibleActiveGoalsAfterProLoss(goals, plan)
  const selectedGoal = activeGoals.find(goal => goal.id === form.goalId)
  const goalSummary = selectedGoal ? calculateGoalSummary(selectedGoal, projects, selectedGoal.ledger) : null
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const selectCategory = category => setForm(current => {
    const nextFields = getExtraFields(category)
    return {
      ...current,
      category,
      vin: nextFields.hasVin ? current.vin : '',
      hullNumber: nextFields.hasHull ? current.hullNumber : '',
      vehicleYear: nextFields.hasVehicleDetails ? current.vehicleYear : '',
      vehicleMake: nextFields.hasVehicleDetails ? current.vehicleMake : '',
      vehicleModel: nextFields.hasVehicleDetails ? current.vehicleModel : '',
      transmission: nextFields.hasVehicleDetails ? current.transmission : '',
      engineModel: nextFields.hasEngine ? current.engineModel : '',
      engineSerial: nextFields.hasEngine ? current.engineSerial : '',
    }
  })


  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) return alert('Give your project a name')
    if (!form.category) return alert('Select a category')
    if (form.goalId && !selectedGoal) return alert('That Trade-Up Goal is no longer active. Choose another goal or create this project without one.')
    const purchase = Number(form.purchasePrice) || 0
    const goalFunding = Number(form.goalFundingAmount) || 0
    if (goalFunding > purchase) return alert('Goal funds cannot exceed the purchase price')
    if (goalSummary && goalFunding > goalSummary.available) return alert('That is more than the amount available toward this goal')
    setSaving(true)
    try {
      await createProject(user.id, {
        ...form,
        photo: photos[0] || null,
        photos,
        goalId: form.goalId || null,
        goalFundingAmount: goalFunding,
        outOfPocketAmount: Math.max(0, purchase - goalFunding),
      })
      captureEvent('project_created', { project_category: form.category, is_goal_linked: Boolean(form.goalId) })
      await refresh()
      navigate(form.goalId ? '/goals' : '/')
    } catch (err) {
      alert('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <button className="back-btn" onClick={() => navigate(-1)}>‹</button>
        <h1>New Project</h1>
      </div>

      <div className="page">
        <form onSubmit={handleSubmit}>

          {/* Project photos */}
          <div className="form-group">
            <label>Project Photos (optional)</label>
            <ProjectPhotoGallery userId={user.id} photos={photos} project={{ photo: photos[0] }} plan={plan} onUpdate={async next => setPhotos(next)} onUpgrade={() => navigate('/upgrade')} />
          </div>

          {/* Title */}
          <div className="form-group">
            <label>Project Name *</label>
            <input
              type="text"
              placeholder="e.g. Honda HRR216 Mower"
              value={form.title}
              onChange={e => set('title', e.target.value)}
            />
          </div>

          {/* Category */}
          <div className="form-group">
            <label>Category *</label>
            <select value={form.category} onChange={e => selectCategory(e.target.value)} required>
              <option value="" disabled>Select a category</option>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>

          {/* Purchase Price */}
          <div className="form-group">
            <label>Purchase Price</label>
            <input
              type="number" inputMode="decimal" placeholder="0.00"
              value={form.purchasePrice}
              onChange={e => set('purchasePrice', e.target.value)}
            />
          </div>

          {activeGoals.length > 0 && (
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="form-group">
                <label>Trade-Up Goal (optional)</label>
                <select value={form.goalId} onChange={e => { set('goalId', e.target.value); set('goalFundingAmount', '') }}>
                  <option value="">Not part of a goal</option>
                  {activeGoals.map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
                </select>
              </div>
              {selectedGoal && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Use from goal <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({fmt(goalSummary.available)} available)</span></label>
                  <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" value={form.goalFundingAmount} onChange={e => set('goalFundingAmount', e.target.value)} />
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Any remaining purchase amount is recorded as personal money contributed.</div>
                </div>
              )}
            </div>
          )}

          {/* ── Category-specific identifiers ── */}
          {(fields.hasVin || fields.hasHull) && (
            <div className="form-group">
              <label>{fields.hasHull ? 'Hull Number' : 'VIN Number'}</label>
              <input
                type="text"
                placeholder={fields.hasHull ? 'e.g. ABC12345D102' : 'e.g. 1HGCM82633A123456'}
                value={fields.hasVin ? form.vin : form.hullNumber}
                onChange={e => set(fields.hasVin ? 'vin' : 'hullNumber', e.target.value)}
              />
            </div>
          )}

          {fields.hasVehicleDetails && (
            <>
              <section aria-label="Unconfirmed editable review"><VinDecodePanel values={form} onChange={setForm} /></section>
              <div className="card" style={{ marginBottom: 18 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Vehicle details (manual entry)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="form-group"><label>Year</label><input inputMode="numeric" value={form.vehicleYear} onChange={e => set('vehicleYear', e.target.value)} /></div>
                  <div className="form-group"><label>Make</label><input value={form.vehicleMake} onChange={e => set('vehicleMake', e.target.value)} /></div>
                  <div className="form-group"><label>Model</label><input value={form.vehicleModel} onChange={e => set('vehicleModel', e.target.value)} /></div>
                  <div className="form-group"><label>Transmission type</label><input value={form.transmission} onChange={e => set('transmission', e.target.value)} /></div>
                </div>
              </div>
            </>
          )}

          {fields.hasModel && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label>Model #</label>
                <input
                  type="text" placeholder="e.g. HRR216K9"
                  value={form.modelNumber}
                  onChange={e => set('modelNumber', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Serial #</label>
                <input
                  type="text" placeholder="e.g. SN-1234567"
                  value={form.serialNumber}
                  onChange={e => set('serialNumber', e.target.value)}
                />
              </div>
            </div>
          )}

          {fields.hasEngine && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label>Engine Model</label>
                <input
                  type="text" placeholder="e.g. GCV170"
                  value={form.engineModel}
                  onChange={e => set('engineModel', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Engine Serial</label>
                <input
                  type="text" placeholder="e.g. GJAFA-1234567"
                  value={form.engineSerial}
                  onChange={e => set('engineSerial', e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Notes */}
          <div className="form-group">
            <label>Notes (optional)</label>
            <textarea
              placeholder="What's wrong with it? What's the plan?"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
            />
          </div>

          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Create Project →'}</button>
        </form>
      </div>
    </>
  )
}
