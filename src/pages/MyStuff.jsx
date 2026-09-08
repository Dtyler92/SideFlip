import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext.jsx'
import { listMyStuffItemsV2 } from '../myStuff/api.js'
import { canCreateMyStuffItem } from '../myStuff/mutation.js'
import './myStuff.css'

export default function MyStuff(){
  const navigate=useNavigate();const {user,entitlement}=useAuth();const [items,setItems]=useState([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('')
  const load=useCallback(async()=>{if(!user?.id)return;setLoading(true);setError('');try{setItems(await listMyStuffItemsV2(user.id,{includeArchived:true,excludeTransferred:true}))}catch(next){setError(next.message||'Could not load your items.')}finally{setLoading(false)}},[user?.id])
  useEffect(()=>{void load()},[load]);const canCreate=canCreateMyStuffItem({isPro:entitlement?.plan==='pro',itemCount:items.length})
  return <main className="mystuff-shell" aria-labelledby="mystuff-heading">
    <header className="mystuff-hero"><p className="mystuff-eyebrow">OWNERSHIP</p><h1 id="mystuff-heading">My Stuff</h1><p>Keep identity, purchase details, usage readings, expenses, and history for the things you own.</p></header>
    {error&&<div className="mystuff-error" role="alert"><span>{error}</span><button type="button" onClick={load}>Try again</button></div>}
    <button className="btn btn-primary" type="button" onClick={()=>navigate('/my-stuff/new')} disabled={!canCreate}>Add an item</button>
    {!canCreate&&<aside className="mystuff-plan" aria-label="Free plan item limit"><strong>Free includes one My Stuff item.</strong><p>Your existing items and their history always remain available. SideFlip Pro supports additional items.</p></aside>}
    <section aria-labelledby="your-items"><div className="mystuff-section-heading"><h2 id="your-items">Your items</h2><button type="button" className="mystuff-link" onClick={load} disabled={loading}>{loading?'Loading…':'Refresh'}</button></div>
      {!loading&&items.length===0?<div className="mystuff-empty"><h3>Nothing here yet</h3><p>Add an item to start its ownership record.</p></div>:<div className="mystuff-grid">{items.map(item=><button type="button" className="mystuff-item" key={item.id} onClick={()=>navigate(`/my-stuff/${item.id}`)} aria-label={`Open ${item.name}${item.archived_at?', archived':''}`}><span><strong>{item.name}</strong><small>{item.itemType.replaceAll('_',' ')}{item.archived_at?' · Archived':''}</small></span><span className="mystuff-readings">{Object.entries(item.currentUsage).map(([axis,value])=><small key={axis}>{Number(value).toLocaleString()} {axis==='miles'?'mi':axis}</small>)}{item.acquired_on&&<small>Acquired {item.acquired_on}</small>}</span><b aria-hidden="true">›</b></button>)}</div>}
    </section>
  </main>
}
