import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { getPlan } from '../capabilities.js'
import { listMyStuffItemsV2 } from '../myStuff/api.js'
import { canCreateMyStuffItem, isMyStuffItemLockedAfterProLoss } from '../myStuff/mutation.js'
import UpgradePrompt from '../components/UpgradePrompt.jsx'
import './myStuff.css'

export default function MyStuff(){
  const navigate=useNavigate()
  const {user,profile,entitlement}=useAuth()
  const [items,setItems]=useState([])
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [upgradeMessage,setUpgradeMessage]=useState('')
  const plan=getPlan(profile,entitlement)
  const load=useCallback(async()=>{if(!user?.id)return;setLoading(true);setError('');try{setItems(await listMyStuffItemsV2(user.id,{includeArchived:true,excludeTransferred:true}))}catch(next){setError(next.message||'Could not load your items.')}finally{setLoading(false)}},[user?.id])
  useEffect(()=>{void load()},[load])
  const canCreate=canCreateMyStuffItem({isPro:plan==='pro',itemCount:items.length})
  const requestUpgrade=message=>setUpgradeMessage(message)
  const addItem=()=>canCreate?navigate('/my-stuff/new'):requestUpgrade('Free includes one My Stuff item. Upgrade to add and maintain more items.')

  return <main className="mystuff-shell" aria-labelledby="mystuff-heading">
    <header className="mystuff-hero"><p className="mystuff-eyebrow">OWNERSHIP</p><h1 id="mystuff-heading">My Stuff</h1><p>Keep track of service intervals for your items</p></header>
    {error&&<div className="mystuff-error" role="alert"><span>{error}</span><button type="button" onClick={load}>Try again</button></div>}
    <button className="btn btn-primary" type="button" onClick={addItem}>Add an item</button>
    {!canCreate&&<aside className="mystuff-plan" aria-label="Free plan item limit"><strong>Free includes one My Stuff item.</strong><p>Your oldest item remains available. Newer items stay visible but require SideFlip Pro to open and manage.</p><button type="button" className="mystuff-link" onClick={()=>requestUpgrade('Upgrade to SideFlip Pro to add and manage more than one My Stuff item.')}>View SideFlip Pro</button></aside>}
    <section aria-labelledby="your-items"><div className="mystuff-section-heading"><h2 id="your-items">Your items</h2><button type="button" className="mystuff-link" onClick={load} disabled={loading}>{loading?'Loading…':'Refresh'}</button></div>
      {!loading&&items.length===0?<div className="mystuff-empty"><h3>Nothing here yet</h3><p>Add an item to start its ownership record.</p></div>:<div className="mystuff-grid">{items.map(item=>{
        const locked=isMyStuffItemLockedAfterProLoss(item,items,plan)
        return <button type="button" className={`mystuff-item${locked?' mystuff-item-locked':''}`} key={item.id} onClick={()=>locked?requestUpgrade('This item is safely preserved. Upgrade to SideFlip Pro to open and continue managing it.'):navigate(`/my-stuff/${item.id}`)} aria-disabled={locked||undefined} aria-label={`${locked?'Unlock':'Open'} ${item.name}${item.archived_at?', archived':''}`}>
          <span><strong>{item.name}</strong><small>{item.itemType.replaceAll('_',' ')}{item.archived_at?' · Archived':''}</small>{locked&&<small className="mystuff-lock-notice">SideFlip Pro required</small>}</span>
          {!locked&&<span className="mystuff-readings">{Object.entries(item.currentUsage).map(([axis,value])=><small key={axis}>{Number(value).toLocaleString()} {axis==='miles'?'mi':axis}</small>)}{item.acquired_on&&<small>Acquired {item.acquired_on}</small>}</span>}
          <b aria-hidden="true">{locked?'🔒':'›'}</b>
        </button>
      })}</div>}
    </section>
    <UpgradePrompt open={Boolean(upgradeMessage)} message={upgradeMessage} onDismiss={()=>setUpgradeMessage('')}/>
  </main>
}
