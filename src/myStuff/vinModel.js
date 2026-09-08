const VIN_LENGTH = 17
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/
const NORTH_AMERICAN_WMI = /^[1-5]/
const TRANSLITERATION = Object.freeze({ A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 })
const WEIGHTS = Object.freeze([8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2])

export const VIN_IDENTIFIER_MAX_LENGTHS = Object.freeze({ project:256, my_stuff_item:64 })
export const VIN_SUGGESTION_FIELDS = Object.freeze(['year','make','model','trim','series','bodyStyle','vehicleType','manufacturer','plantName','plantCountry','vehicleMarket','fuelType','engineCylinders','engineDisplacementLiters','engineModel','transmission','drivetrain','engine','bodyClass'])
export const VIN_CONFIRMATION_PERSISTENCE_FIELDS = Object.freeze(['vin','year','manufacturer','make','model','trim','series','engine','engineModel','engineDisplacementLiters','engineCylinders','transmission','drivetrain','fuelType','vehicleType','bodyStyle','plantName','plantCountry','vehicleMarket'])

export const normalizeVin = input => String(input ?? '').trim().toUpperCase().replace(/[ -]/g,'')

export function calculateVinCheckDigit(input) {
  const vin=normalizeVin(input)
  if(vin.length!==VIN_LENGTH||/[^A-Z0-9]/.test(vin)||/[IOQ]/.test(vin))return null
  let total=0
  for(let index=0;index<VIN_LENGTH;index+=1){const character=vin[index];const value=/\d/.test(character)?Number(character):TRANSLITERATION[character];if(value==null)return null;total+=value*WEIGHTS[index]}
  const remainder=total%11
  return remainder===10?'X':String(remainder)
}

export function validateVin(input,{checkDigitApplicable}={}) {
  const normalized=normalizeVin(input)
  if(!normalized)return {normalized,kind:'manual',valid:false,canDecode:false,reason:'Enter a VIN or identifier.'}
  if(normalized.length!==VIN_LENGTH)return {normalized,kind:'manual',valid:true,canDecode:false,reason:'Older or nonstandard identifiers are kept for manual entry and cannot be automatically decoded.'}
  if(/[IOQ]/.test(normalized))return {normalized,kind:'standard',valid:false,canDecode:false,reason:'A standard VIN cannot contain I, O, or Q.'}
  if(!VIN_PATTERN.test(normalized))return {normalized,kind:'standard',valid:false,canDecode:false,reason:'A standard VIN must contain exactly 17 letters and numbers.'}
  const applicable=typeof checkDigitApplicable==='boolean'?checkDigitApplicable:NORTH_AMERICAN_WMI.test(normalized)
  const checkDigitValid=applicable?calculateVinCheckDigit(normalized)===normalized[8]:null
  return {normalized,kind:'standard',valid:checkDigitValid!==false,canDecode:checkDigitValid!==false,checkDigitApplicable:applicable,checkDigitValid,reason:checkDigitValid===false?'VIN check digit does not match.':null}
}

export function maskVin(input,visibleCharacters=4){const normalized=normalizeVin(input);if(!normalized)return '';if(normalized.length===1)return '•';const visible=Math.max(1,Math.min(Number.isInteger(visibleCharacters)?visibleCharacters:4,normalized.length-1));return `${'•'.repeat(normalized.length-visible)}${normalized.slice(-visible)}`}
const blank=value=>value==null||(typeof value==='string'&&value.trim()==='')
const equivalent=(left,right)=>String(left).trim().toLocaleLowerCase()===String(right).trim().toLocaleLowerCase()

export function mergeDecodedSuggestions(existing={},decoded={}) {
  const values={...existing},fields={}
  for(const field of VIN_SUGGESTION_FIELDS){const current=existing[field],suggestion=decoded[field];if(blank(suggestion)){if(!blank(current))fields[field]={status:'user_confirmed',existing:current};continue}if(blank(current)){values[field]=suggestion;fields[field]={status:'suggested',suggestion}}else if(equivalent(current,suggestion))fields[field]={status:'verified',existing:current,suggestion};else fields[field]={status:'conflicting',existing:current,suggestion}}
  return {values,fields}
}

export function decodedVehicleSuggestions(vehicle={}) {
  const year=Number(vehicle.modelYear),cylinders=Number(vehicle.engineCylinders),displacement=Number(vehicle.displacementLiters)
  const engineParts=[Number.isFinite(displacement)?`${displacement}L`:null,Number.isFinite(cylinders)?`${cylinders} cylinders`:null].filter(Boolean)
  const mapped={year:Number.isInteger(year)?year:vehicle.modelYear,make:vehicle.make,model:vehicle.model,trim:vehicle.trim,series:vehicle.series,bodyStyle:vehicle.bodyClass,bodyClass:vehicle.bodyClass,vehicleType:vehicle.vehicleType,manufacturer:vehicle.manufacturer,plantName:vehicle.plantName,plantCountry:vehicle.plantCountry,vehicleMarket:vehicle.vehicleMarket,fuelType:vehicle.fuelTypePrimary,engineCylinders:Number.isFinite(cylinders)?cylinders:vehicle.engineCylinders,engineDisplacementLiters:Number.isFinite(displacement)?displacement:vehicle.displacementLiters,engineModel:vehicle.engineModel,engine:engineParts.length?engineParts.join(' · '):vehicle.engineModel,transmission:vehicle.transmissionStyle,drivetrain:vehicle.driveType}
  return Object.fromEntries(Object.entries(mapped).filter(([,value])=>!blank(value)))
}

export function applyVinSuggestions(existing={},previewFields={}, {mode='selected',fields=[]}={}) {const result={...existing},selected=new Set(fields);for(const [field,preview] of Object.entries(previewFields)){if(!preview||!Object.hasOwn(preview,'suggestion'))continue;if(mode==='fill_blanks'){if(preview.status==='suggested'&&blank(existing[field]))result[field]=preview.suggestion}else if(selected.has(field))result[field]=preview.suggestion}return result}
export function buildVehicleConfirmationSnapshot(values={},previewFields={}) {const merged=applyVinSuggestions(values,previewFields,{mode:'fill_blanks'});merged.vin=normalizeVin(values.vin);return Object.fromEntries(VIN_CONFIRMATION_PERSISTENCE_FIELDS.filter(field=>!blank(merged[field])).map(field=>[field,merged[field]]))}
export function hasVehicleIdentityChanged(confirmed={},current={}) {return VIN_CONFIRMATION_PERSISTENCE_FIELDS.some(field=>String(confirmed[field]??'').trim()!==String(current[field]??'').trim())}
export async function persistThenConfirmVehicleIdentity({snapshot,persist,confirm,isCurrent}) {await persist(snapshot);if(!isCurrent(snapshot))return {confirmed:false,stale:true};await confirm(snapshot);if(!isCurrent(snapshot))return {confirmed:false,stale:true};return {confirmed:true,stale:false}}
export function createVinDecodeRequestGate(){let generation=0,activeController=null;return {begin(vin){activeController?.abort();const request={generation:++generation,normalizedVin:normalizeVin(vin),controller:new AbortController()};activeController=request.controller;return request},invalidate(){generation+=1;activeController?.abort();activeController=null},isCurrent(request,vin){return request?.generation===generation&&request.normalizedVin===normalizeVin(vin)&&!request.controller.signal.aborted},finish(request){if(request?.generation!==generation)return false;activeController=null;return true}}}
