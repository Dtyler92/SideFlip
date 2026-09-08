import { adaptSqlItem } from './adapters.js'
import { excludeTransferredItems } from './transferVisibility.js'
import { normalizeExpenseRows } from './v3Model.js'

function dataOrThrow(result, fallbackMessage='My Stuff request failed.'){if(result?.error){const message=result.error.message||fallbackMessage;const error=new Error(message);error.code=result.error.code;throw error}return result?.data}
const compactObject=value=>Object.fromEntries(Object.entries(value).filter(([,entry])=>entry!==''&&entry!=null))
const transferOptionsPayload=(options={})=>compactObject({project_disposition:options.projectDisposition??options.project_disposition,current_mileage:options.currentMileage??options.current_mileage,current_hours:options.currentHours??options.current_hours,current_cycles:options.currentCycles??options.current_cycles,usage_dimensions:options.usageDimensions??options.usage_dimensions,service_expense_ids:options.serviceExpenseIds??options.service_expense_ids??[]})

export function createMyStuffClient(database){
  const rpc=async(name,payload)=>dataOrThrow(await database.rpc(name,payload),`Could not complete ${name}.`)
  return {
    async listItems(userId,{includeArchived=true,excludeTransferred=false}={}){
      if(!userId)throw new Error('Authentication is required to load My Stuff.')
      let query=database.from('my_stuff_items').select('*').eq('user_id',userId).order('created_at',{ascending:false})
      if(!includeArchived)query=query.is('archived_at',null)
      const [itemsResult,transfersResult]=await Promise.all([query,excludeTransferred?database.from('my_stuff_to_project_transfers').select('item_id').eq('user_id',userId):Promise.resolve({data:[],error:null})])
      const items=dataOrThrow(itemsResult,'Could not load your My Stuff items.')||[];const transfers=dataOrThrow(transfersResult,'Could not determine transferred-item visibility.')||[]
      return excludeTransferredItems(items,transfers).map(adaptSqlItem)
    },
    async getItem(userId,itemId){
      if(!userId)throw new Error('Authentication is required to load this item.')
      const [itemResult,readingsResult]=await Promise.all([
        database.from('my_stuff_items').select('*').eq('user_id',userId).eq('id',itemId).single(),
        database.from('my_stuff_readings').select('*').eq('user_id',userId).eq('item_id',itemId).order('created_at',{ascending:false}).order('id',{ascending:false}),
      ])
      return {item:adaptSqlItem(dataOrThrow(itemResult,'This My Stuff item was not found or is not yours.')),readings:dataOrThrow(readingsResult,'Could not load item readings.')||[]}
    },
    createItemV2:(wirePayload,mutationId)=>rpc('create_my_stuff_item_v2',{...wirePayload,p_mutation_id:mutationId}),
    updateItemV2:(wirePayload,mutationId)=>rpc('update_my_stuff_item_v2',{...wirePayload,p_mutation_id:mutationId}),
    setArchivedV2:values=>rpc('set_my_stuff_item_archived_v2',{p_item_id:values.itemId,p_archived:values.archived,p_reason:values.reason||null,p_mutation_id:values.mutationId}),
    recordReadingV2:(wirePayload,mutationId)=>rpc('record_my_stuff_reading_v2',{...wirePayload,p_mutation_id:mutationId}),
    async deleteItem(userId,itemId){if(!userId)throw new Error('Authentication is required to delete this item.');const result=await database.from('my_stuff_items').delete().eq('id',itemId).eq('user_id',userId);dataOrThrow(result,'Could not delete this item.')},
  }
}

export function createMyStuffV3Client(database){
  const call=async(name,payload)=>dataOrThrow(await database.rpc(name,payload),`Could not complete ${name}.`)
  return {
    createExpense:(itemId,expense,mutationId)=>call('create_my_stuff_expense_v3',{p_item_id:itemId,p_expense:expense,p_mutation_id:mutationId}),
    reviseExpense:(expenseId,patch,reason,mutationId)=>call('revise_my_stuff_expense_v3',{p_expense_id:expenseId,p_patch:patch,p_reason:reason,p_mutation_id:mutationId}),
    voidExpense:(expenseId,reason,mutationId)=>call('void_my_stuff_expense_v3',{p_expense_id:expenseId,p_reason:reason,p_mutation_id:mutationId}),
    getExpenses:async itemId=>normalizeExpenseRows((await call('get_my_stuff_expenses_v3',{p_item_id:itemId}))||[]),
    getFinancialSummary:itemId=>call('get_my_stuff_financial_summary_v3',{p_item_id:itemId}),
    transferProject:(projectId,options,mutationId)=>call('transfer_project_to_my_stuff_v3',{p_project_id:projectId,p_options:transferOptionsPayload(options),p_mutation_id:mutationId}),
    transferItemToProject:(itemId,mutationId)=>call('transfer_my_stuff_to_project_v1',{p_item_id:itemId,p_mutation_id:mutationId}),
  }
}
