import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../supabase.js'
import { confirmMyStuffVehicleIdentityV3 } from '../myStuff/api.js'
import { createMutationAttemptState, mutationIdForPayload, resetMutationAttemptState } from '../myStuff/mutation.js'
import {
  applyVinSuggestions,
  buildVehicleConfirmationSnapshot,
  createVinDecodeRequestGate,
  decodedVehicleSuggestions,
  hasVehicleIdentityChanged,
  maskVin,
  mergeDecodedSuggestions,
  normalizeVin,
  persistThenConfirmVehicleIdentity,
  validateVin,
} from '../myStuff/vinModel.js'
import './myStuffResearch.css'

const FIELD_LABELS={year:'Model year',make:'Make',model:'Model',trim:'Trim / version',series:'Series',bodyStyle:'Body style',vehicleType:'Vehicle type',manufacturer:'Manufacturer',plantName:'Plant',plantCountry:'Plant country',vehicleMarket:'Market',fuelType:'Fuel / power type',engineCylinders:'Engine cylinders',engineDisplacementLiters:'Engine displacement (L)',engineModel:'Engine model',engine:'Engine / power system',transmission:'Transmission type',drivetrain:'Drivetrain'}
const ALWAYS_EDITABLE=['transmission']

function ensureEditable(review,values){const fields={...(review?.fields||{})};for(const field of ALWAYS_EDITABLE)fields[field]||={status:'manual',existing:values[field]??''};return {...review,fields}}
function suggestionsFromFields(fields){return Object.fromEntries(Object.entries(fields).filter(([,detail])=>detail?.suggestion!=null).map(([field,detail])=>[field,detail.suggestion]))}

export default function MyStuffVinDecodePanel({itemId,values,onChange,persistIdentity,onIdentityConfirmed,operationLock,disabled=false,fieldLabels={},suggestionFields,initiallyExpanded=false,preSave=false}) {
  const [expanded,setExpanded]=useState(initiallyExpanded)
  const [decoding,setDecoding]=useState(false)
  const [confirming,setConfirming]=useState(false)
  const [confirmed,setConfirmed]=useState(false)
  const [preview,setPreview]=useState(null)
  const [warnings,setWarnings]=useState([])
  const [message,setMessage]=useState('')
  const valuesRef=useRef(values);valuesRef.current=values
  const gate=useRef(createVinDecodeRequestGate())
  const confirmationGeneration=useRef(0)
  const confirmationAttempt=useRef(createMutationAttemptState())
  const vinState=useMemo(()=>validateVin(values?.vin),[values?.vin])

  useEffect(()=>{gate.current.invalidate();confirmationGeneration.current+=1;resetMutationAttemptState(confirmationAttempt.current);setPreview(null);setWarnings([]);setMessage('');setConfirmed(false);setExpanded(initiallyExpanded);return()=>{gate.current.invalidate();confirmationGeneration.current+=1}},[itemId,initiallyExpanded])

  function update(next){valuesRef.current=next;confirmationGeneration.current+=1;setConfirmed(false);onChange?.(next)}
  function editVin(vin){gate.current.invalidate();setDecoding(false);update({...valuesRef.current,vin});setPreview(null);setWarnings([]);setMessage('')}
  function refreshPreview(next){setPreview(current=>current?{...ensureEditable(mergeDecodedSuggestions(next,suggestionsFromFields(current.fields)),next),requestVin:current.requestVin}:null)}
  function editReviewField(field,value){
    if(preSave){setPreview(current=>current?{...current,values:{...current.values,[field]:value}}:null);return}
    const next={...valuesRef.current,[field]:value};update(next);refreshPreview(next)
  }
  function fillBlanks(){
    if(!preview||preview.requestVin!==normalizeVin(valuesRef.current?.vin))return
    if(preSave){setPreview(current=>current?{...current,values:applyVinSuggestions(current.values,current.fields,{mode:'fill_blanks'})}:null);return}
    const next=applyVinSuggestions(valuesRef.current,preview.fields,{mode:'fill_blanks'});update(next);refreshPreview(next)
  }
  function useSuggestion(field){
    if(!preview||preview.requestVin!==normalizeVin(valuesRef.current?.vin))return
    if(preSave){setPreview(current=>current?{...current,values:{...current.values,[field]:current.fields[field]?.suggestion}}:null);return}
    const next=applyVinSuggestions(valuesRef.current,preview.fields,{fields:[field]});update(next);refreshPreview(next)
  }
  function applyPreSaveReview(){
    if(!preSave||!preview||preview.requestVin!==normalizeVin(valuesRef.current?.vin))return
    const reviewed={}
    for(const [field,detail] of Object.entries(preview.fields)){
      const isVisibleReviewField=detail?.suggestion!=null||ALWAYS_EDITABLE.includes(field)
      if(isVisibleReviewField&&Object.hasOwn(preview.values||{},field))reviewed[field]=preview.values[field]
    }
    const next={...valuesRef.current,...reviewed,vin:preview.requestVin}
    update(next)
    setMessage('Reviewed values applied to this draft. They are not saved until you select Add item.')
    refreshPreview(next)
  }

  async function decode(){
    if(!vinState.canDecode){setMessage(vinState.reason||'Enter a standard 17-character VIN, or continue with manual entry.');return}
    const request=gate.current.begin(vinState.normalized);setDecoding(true);setPreview(null);setWarnings([]);setMessage('')
    try{
      const {data,error:authError}=await supabase.auth.getSession();const token=data?.session?.access_token
      if(authError||!token)throw new Error('Please sign in again.')
      const decodeBody={vin:request.normalizedVin,subjectType:'my_stuff_item'}
      if(!preSave)decodeBody.subjectId=itemId
      const response=await fetch('/api/decode-vin',{method:'POST',signal:request.controller.signal,headers:{'Content-Type':'application/json',Authorization:['Bearer',token].join(' ')},body:JSON.stringify(decodeBody)})
      const payload=await response.json().catch(()=>({}))
      if(!gate.current.isCurrent(request,valuesRef.current?.vin))return
      if(!response.ok)throw new Error(payload.error||'VIN decoding failed.')
      const decoded=decodedVehicleSuggestions(payload.vehicle)
      const supported=Array.isArray(suggestionFields)?Object.fromEntries(Object.entries(decoded).filter(([field])=>suggestionFields.includes(field))):decoded
      setPreview({...ensureEditable(mergeDecodedSuggestions(valuesRef.current,supported),valuesRef.current),requestVin:request.normalizedVin})
      setWarnings(Array.isArray(payload.nhtsaWarnings)?payload.nhtsaWarnings:[])
    }catch(error){if(gate.current.isCurrent(request,valuesRef.current?.vin)&&error?.name!=='AbortError')setMessage(`${error?.message||'VIN decoding failed.'} Manual entry is still available.`)}
    finally{if(gate.current.finish(request))setDecoding(false)}
  }

  async function confirmVehicle(){
    if(confirming||disabled)return
    if(!itemId)return setMessage('Save this item before confirming its vehicle identity.')
    if(typeof persistIdentity!=='function')return setMessage('Vehicle confirmation is not connected. Save the item details manually instead.')
    if(!preview||preview.requestVin!==vinState.normalized)return setMessage('Decode the current VIN before confirming vehicle identity.')
    const snapshot=buildVehicleConfirmationSnapshot(valuesRef.current,preview.fields)
    const nextValues={...valuesRef.current,...snapshot};update(nextValues)
    const generation=++confirmationGeneration.current
    const mutationId=mutationIdForPayload(confirmationAttempt.current,{itemId,identity:snapshot})
    if(operationLock?.current)return setMessage('Wait for the current item update to finish before confirming vehicle identity.')
    if(operationLock)operationLock.current=true
    setConfirming(true);setMessage('')
    try{
      const isCurrent=()=>generation===confirmationGeneration.current&&!hasVehicleIdentityChanged(snapshot,valuesRef.current)
      const result=await persistThenConfirmVehicleIdentity({snapshot,persist:persistIdentity,confirm:identity=>confirmMyStuffVehicleIdentityV3(itemId,identity,mutationId),isCurrent})
      if(!result.confirmed)return
      resetMutationAttemptState(confirmationAttempt.current);setConfirmed(true);setMessage('Vehicle identity confirmed. Manufacturer maintenance research can now be started separately.');await onIdentityConfirmed?.()
    }catch(error){if(generation===confirmationGeneration.current)setMessage(`${error?.message||'Vehicle confirmation is unavailable.'} Your editable review is still here and manual entry remains available.`)}
    finally{if(operationLock)operationLock.current=false;if(generation===confirmationGeneration.current)setConfirming(false)}
  }

  const entries=preview?Object.entries(preview.fields).filter(([field,detail])=>detail.suggestion!=null||ALWAYS_EDITABLE.includes(field)):[]
  const blocked=disabled||decoding||confirming
  return <section className="mystuff-tool" aria-labelledby={`vin-decoder-${itemId||'new'}`}>
    <button type="button" className="mystuff-tool-toggle" onClick={()=>setExpanded(value=>!value)} aria-expanded={expanded}><span id={`vin-decoder-${itemId||'new'}`}>VIN Decoder <small>BASIC</small></span><span aria-hidden="true">{expanded?'⌃':'⌄'}</span></button>
    {expanded&&<div className="mystuff-tool-body">
      <p>Basic decode is available to signed-in Free and Pro accounts. To decode vehicle details, your full VIN is sent to NHTSA. Decoded values are an unconfirmed editable review and never save automatically.</p>
      <label htmlFor={`mystuff-vin-${itemId||'new'}`}>VIN / identifier</label><input id={`mystuff-vin-${itemId||'new'}`} value={values?.vin||''} onChange={event=>editVin(event.target.value)} maxLength="64" autoCapitalize="characters" autoCorrect="off" placeholder="17-character VIN or manual identifier"/>
      {!!values?.vin&&!vinState.canDecode&&<p className="mystuff-tool-muted">{vinState.reason}</p>}
      <button type="button" className="btn btn-secondary" disabled={blocked||!vinState.canDecode} onClick={decode}>{decoding?'Decoding…':'Decode VIN'}</button>
      {!!message&&<p className="mystuff-tool-message" role="status">{message}</p>}
      {warnings.map(warning=><p className="mystuff-tool-warning" key={warning.code}>NHTSA warning: {warning.message}</p>)}
      {preview&&<div className="mystuff-tool-review"><h3>Unconfirmed editable review for {maskVin(preview.requestVin)}</h3>{entries.length===0?<p>No additional vehicle details were returned.</p>:entries.map(([field,detail])=><div className="mystuff-vin-suggestion" key={field}><div><label htmlFor={`vin-review-${field}`}>{fieldLabels[field]||FIELD_LABELS[field]||field}</label><input id={`vin-review-${field}`} value={String(preview.values?.[field]??detail.suggestion??'')} onChange={event=>editReviewField(field,event.target.value)}/>{detail.status==='conflicting'&&<small className="mystuff-tool-error">Decoder: {String(detail.suggestion)} · Unconfirmed</small>}{detail.status==='suggested'&&<small>NHTSA suggestion · Unconfirmed</small>}{detail.status==='verified'&&<small className="mystuff-tool-ok">Verified match with current value</small>}{detail.status==='manual'&&<small>Not returned by NHTSA · enter and verify manually</small>}</div>{detail.status==='conflicting'&&<button type="button" className="mystuff-link" onClick={()=>useSuggestion(field)}>Use suggestion</button>}</div>)}
        {!preSave&&entries.some(([,detail])=>detail.status==='suggested')&&<button type="button" className="btn" onClick={fillBlanks}>Fill blank fields</button>}
        {preSave ? <><button type="button" className="btn btn-primary" disabled={blocked} onClick={applyPreSaveReview}>Apply reviewed values</button><p className="mystuff-tool-muted">Applying updates this form only. Nothing is saved until you select Add item.</p></> : <button type="button" className="btn btn-primary" disabled={blocked} onClick={confirmVehicle}>{confirming?'Confirming…':confirmed?'Vehicle Confirmed':'Confirm Vehicle'}</button>}
      </div>}
    </div>}
  </section>
}
