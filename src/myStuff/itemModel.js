export const MEASUREMENT_TYPES = Object.freeze(['miles','hours','cycles'])

const CONTRACTS=Object.freeze({
  vehicle:Object.freeze({category:'vehicle',label:'Vehicle',measurements:Object.freeze(['miles','hours','cycles']),identityFields:Object.freeze(['year','make','model','trim','engine','transmission','drivetrain','fuelType'])}),
  motorcycle:Object.freeze({category:'motorcycle',label:'Motorcycle',measurements:Object.freeze(['miles','hours','cycles']),identityFields:Object.freeze(['year','make','model','trim','engine'])}),
  boat:Object.freeze({category:'boat',label:'Boat',measurements:Object.freeze(['miles','hours','cycles']),identityFields:Object.freeze(['year','make','model','engine'])}),
  aircraft:Object.freeze({category:'aircraft',label:'Aircraft',measurements:Object.freeze(['hours','cycles']),identityFields:Object.freeze(['year','make','model','engine'])}),
  equipment:Object.freeze({category:'equipment',label:'Equipment',measurements:Object.freeze(['hours','cycles']),identityFields:Object.freeze(['year','make','model','engine','powerType'])}),
  tool:Object.freeze({category:'tool',label:'Tool',measurements:Object.freeze(['hours','cycles']),identityFields:Object.freeze(['make','model','powerType'])}),
  home:Object.freeze({category:'home',label:'Home',measurements:Object.freeze(['hours','cycles']),identityFields:Object.freeze(['year','make','model'])}),
  appliance:Object.freeze({category:'appliance',label:'Appliance',measurements:Object.freeze(['cycles']),identityFields:Object.freeze(['year','make','model'])}),
  electronics:Object.freeze({category:'electronics',label:'Electronics',measurements:Object.freeze(['cycles']),identityFields:Object.freeze(['year','make','model'])}),
  recreation:Object.freeze({category:'recreation',label:'Recreation',measurements:Object.freeze(['miles','hours','cycles']),identityFields:Object.freeze(['year','make','model','engine'])}),
  other:Object.freeze({category:'other',label:'Other',measurements:Object.freeze(['miles','hours','cycles']),identityFields:Object.freeze(['year','make','model'])}),
})
const type=(value,label,category)=>Object.freeze({value,label,category})
export const ITEM_TYPE_OPTIONS=Object.freeze([
  type('car','Car','vehicle'),type('truck','Truck','vehicle'),type('motorcycle','Motorcycle','motorcycle'),type('boat','Boat','boat'),type('airplane','Airplane','aircraft'),type('atv','ATV','recreation'),type('side_by_side','Side-by-side','recreation'),type('mower','Lawn mower','equipment'),type('tractor','Tractor','equipment'),type('trailer','Trailer','vehicle'),type('generator','Generator','equipment'),type('rv','RV','vehicle'),type('equipment','Other equipment','equipment'),type('bicycle','Bicycle / e-bike','recreation'),type('watch','Watch','other'),type('electronics','Electronics','electronics'),type('gaming','Gaming / console','electronics'),type('tool','Tool','tool'),type('exercise','Exercise equipment','recreation'),type('instrument','Musical instrument','other'),type('furniture','Furniture','home'),type('house','House','home'),type('other','Other','other'),
])
const TYPE_BY_VALUE=Object.freeze(Object.fromEntries(ITEM_TYPE_OPTIONS.map(option=>[option.value,option])))
export const ITEM_CATEGORIES=Object.freeze(Object.keys(CONTRACTS))
export const ITEM_CATEGORY_CONTRACTS=CONTRACTS
const REQUIRED_TYPES=new Set(['car','truck','motorcycle','boat','airplane','atv','side_by_side','mower','tractor','trailer','generator','rv','equipment','bicycle','exercise'])
const ALIASES=Object.freeze({car:'vehicle',truck:'vehicle',atv:'recreation','side by side':'recreation','lawn mower':'equipment',lawnmower:'equipment',tractor:'equipment',trailer:'vehicle',generator:'equipment',rv:'vehicle',bicycle:'recreation',watch:'other',gaming:'electronics',exercise:'recreation',instrument:'other',furniture:'home',house:'home'})
export const MAX_USAGE_READING=1_000_000_000
const key=value=>String(value||'').trim().toLowerCase().replace(/[-_]+/g,' ').replace(/\s+/g,' ')
export function getItemTypeOption(value){return TYPE_BY_VALUE[key(value).replace(/ /g,'_')]||null}
export function deriveItemCategory(value){return getItemTypeOption(value)?.category||'other'}
const VIN_ITEM_TYPES=new Set(['car','truck'])
export function supportsVinDecoder(value){return VIN_ITEM_TYPES.has(getItemTypeOption(value)?.value||'')}
export function requiresResearchIdentityReconfirmation(previousType,nextType){return previousType!==nextType&&supportsVinDecoder(previousType)&&supportsVinDecoder(nextType)}
export function requiresUsageAndPurchase(value){return REQUIRED_TYPES.has(getItemTypeOption(value)?.value||'')}
export function getItemCategoryContract(value){const normalized=key(value);return CONTRACTS[normalized]||CONTRACTS[ALIASES[normalized]]||null}
export function selectItemType(draft={},value){
  const option=getItemTypeOption(value);if(!option)return {...draft,itemType:value}
  const allowed=new Set(CONTRACTS[option.category].measurements)
  const measurements=(Array.isArray(draft.measurements)?draft.measurements:[]).filter(axis=>allowed.has(axis))
  const currentUsage={};for(const axis of measurements)if(Object.hasOwn(draft.currentUsage||{},axis))currentUsage[axis]=draft.currentUsage[axis]
  const next={...draft,itemType:option.value,category:option.category,measurements,currentUsage}
  for(const axis of MEASUREMENT_TYPES)if(!allowed.has(axis))delete next[axis]
  return next
}
export function toggleItemMeasurementDraft(draft={},axis){
  const measurements=Array.isArray(draft.measurements)?draft.measurements:[];const selected=measurements.includes(axis);const currentUsage={...(draft.currentUsage||{})}
  const next={...draft,measurements:selected?measurements.filter(value=>value!==axis):[...measurements,axis],currentUsage}
  if(selected){delete next[axis];delete currentUsage[axis]}return next
}
const validDate=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const [y,m,d]=value.split('-').map(Number);const date=new Date(Date.UTC(y,m-1,d));return y>=1900&&y<=2200&&date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d}
export function validateItemDraft(item={}, {requireOwnershipFields=false}={}){
  const errors={};const name=String(item.name??'').trim();if(!name)errors.name='Item name is required.';else if(name.length>200)errors.name='Item name must be 200 characters or fewer.'
  const selected=item.itemType==null?null:getItemTypeOption(item.itemType);if(item.itemType!=null&&!selected)errors.itemType='Choose a valid specific item type.'
  const contract=getItemCategoryContract(selected?.category||item.category);if(!contract)errors.category='Choose a valid category.';else if(selected&&key(item.category)!==selected.category)errors.category=`Choose the category that matches ${selected.label}.`
  const measurements=Array.isArray(item.measurements)?item.measurements:[];if(new Set(measurements).size!==measurements.length)errors.measurements='Measurement modes cannot contain duplicate values.';else if(contract){const unsupported=measurements.find(axis=>!contract.measurements.includes(axis));if(unsupported)errors.measurements=`${unsupported} is not supported for ${contract.label}.`}
  const required=requireOwnershipFields&&requiresUsageAndPurchase(selected?.value);if(requireOwnershipFields&&measurements.length===0)errors.measurements='Choose at least one usage tracking type.'
  if(required){const raw=item.purchasePrice;const amount=Number(raw);if(raw==null||String(raw).trim()==='')errors.purchasePrice='Purchase price is required.';else if(!Number.isFinite(amount)||amount<0||amount>1e9||Math.abs(amount*100-Math.round(amount*100))>1e-8)errors.purchasePrice='Purchase price must be a non-negative amount with no more than two decimal places.'}
  if(item.year!=null&&item.year!==''){const year=Number(item.year);if(!Number.isInteger(year)||year<1800||year>2200)errors.year='Year must be a whole number between 1800 and 2200.'}
  if(item.acquiredOn&& !validDate(item.acquiredOn))errors.acquiredOn='Acquired on must be a valid date between 1900 and 2200.'
  if(item.usageProfile!=null&&!['normal','severe'].includes(item.usageProfile))errors.usageProfile='Usage profile must be Normal or Severe.'
  if(String(item.vin||'').trim().length>64)errors.vin='VIN must be 64 characters or fewer.'
  const readingErrors=[];const usage=item.currentUsage||{};for(const axis of MEASUREMENT_TYPES){const raw=usage[axis];if(raw!=null&&String(raw).trim()!==''&&!measurements.includes(axis)){readingErrors.push(`Select ${axis==='miles'?'Miles':axis[0].toUpperCase()+axis.slice(1)} before entering its current reading.`);continue}if(measurements.includes(axis)){if(required&&(raw==null||String(raw).trim()==='')){readingErrors.push(`Current ${axis} is required.`);continue}if(raw!=null&&String(raw).trim()!==''){const number=Number(raw);if(!Number.isFinite(number)||number<0||number>MAX_USAGE_READING)readingErrors.push(`${axis} must be a bounded non-negative number.`);else if(axis==='cycles'&&!Number.isInteger(number))readingErrors.push('cycles must be a whole number.')}}}
  if(readingErrors.length)errors.currentUsage=readingErrors.join(' ');return {ok:Object.keys(errors).length===0,errors}
}
