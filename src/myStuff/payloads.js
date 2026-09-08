import { adaptItemDraftToSql, adaptItemPatchToSql, toSqlUsageDimension } from './adapters.js'
export const buildCreateMyStuffItemV2WirePayload=(values={})=>({p_item:adaptItemDraftToSql(values)})
export const buildUpdateMyStuffItemV2WirePayload=(values={})=>({p_item_id:values.itemId,p_patch:adaptItemPatchToSql(values)})
export const buildRecordMyStuffReadingV2WirePayload=(values={})=>({p_item_id:values.itemId,p_reading_type:toSqlUsageDimension(values.readingType),p_value:values.value,p_recorded_at:values.recordedAt,p_corrects_reading_id:values.correctsReadingId||null,p_correction_reason:values.correctionReason?.trim()||null,p_metadata:values.metadata||{}})
