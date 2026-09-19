// Transport-neutral structured output schema. Runtime validator also binds source quotes/context.
const ref = name => ({ $ref: '#/$defs/' + name })
const text = { type:'string', minLength:1, maxLength:20000 }
const obj = (properties, required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false})
const list = (items,minItems=0,maxItems=2000) => ({type:'array',items,minItems,maxItems})
const enumOf = (...values) => ({enum:values})
const ids = list(text)
const interval = obj({miles:{type:'integer',minimum:1,maximum:10000000},months:{type:'integer',minimum:1,maximum:10000000},days:{type:'integer',minimum:1,maximum:10000000},hours:{type:'integer',minimum:1,maximum:10000000}},[])
interval.minProperties=1
const anchor=enumOf('vehicle_origin','last_service'), trigger={const:'whichever_first'}
export const documentExtractionSchema={
  ...obj({schemaVersion:{const:2},sourceSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
    rules:list(ref('rule'),1),evidence:list(ref('evidence'),1),ownerQuestions:list(ref('question')),unresolved:list(ref('unresolved')),coverage:list(ref('coverage'),1)}),
  $defs:{
    interval,
    condition:{oneOf:[obj({op:{const:'always'}}),obj({op:{const:'not'},arg:ref('condition')}),obj({op:enumOf('all','any'),args:list(ref('condition'),1,50)}),obj({op:enumOf('eq','lt','lte','gt','gte'),field:text,value:{type:['string','boolean','number']}})]},
    timing:{oneOf:[
      obj({kind:{const:'recurring'},interval:ref('interval'),anchor,trigger}),
      obj({kind:{const:'milestones'},points:list(ref('interval'),1,500),anchor:{const:'vehicle_origin'},trigger}),
      obj({kind:{const:'first_subsequent'},first:ref('interval'),subsequent:ref('interval'),anchor,trigger}),
      obj({kind:{const:'monitor'},mode:enumOf('vehicle_monitor','source_instruction','inspection_finding','care_instruction','reset_reminder'),instruction:text,responseWindow:ref('interval'),maximum:ref('interval'),fallback:obj({condition:ref('condition'),interval:ref('interval'),anchor:{const:'last_service'},trigger})},['kind','mode','instruction']),
      obj({kind:{const:'service_relative'},service:text,every:{type:'integer',minimum:1,maximum:100},startsAfter:ref('interval'),until:text}),
    ]},
    evidence:obj({id:text,pdfPage:{type:'integer',minimum:1},quote:text,role:enumOf('row','heading','note','exception','definition')}),
    rule:obj({id:text,service:text,action:enumOf('check','inspect','visually_inspect','inspect_adjust','replace','rotate','tighten','adjust','clean','repair','reset','repack','wax'),condition:ref('condition'),timing:ref('timing'),evidenceIds:{...ids,minItems:1},relatedEvidenceIds:ids,overrides:ids}),
    question:obj({field:text,type:enumOf('boolean','number','string'),question:text,evidenceIds:{...ids,minItems:1}}),
    unresolved:obj({reason:text,evidenceIds:{...ids,minItems:1}}),
    coverage:obj({pdfPage:{type:'integer',minimum:1},disposition:enumOf('reviewed_for_extraction','needs_review'),evidenceIds:ids}),
  },
}
