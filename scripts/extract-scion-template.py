#!/usr/bin/env python3
"""Deterministic exact Scion PDF parser + explicitly reviewed semantic annotations.
Not an AI/provider result. Requires PyMuPDF; rejects changed source bytes/layout.
Usage: python3 scripts/extract-scion-template.py PDF [output-directory]
"""
import fitz, hashlib, json, pathlib, re, sys
PDF=pathlib.Path(sys.argv[1]); OUT=pathlib.Path(sys.argv[2] if len(sys.argv)>2 else 'tests/fixtures'); OUT.mkdir(parents=True,exist_ok=True)
doc=fitz.open(PDF); texts=[p.get_text() for p in doc]
def norm(s): return re.sub(r'\s+',' ',s).strip()
assert hashlib.sha256(PDF.read_bytes()).hexdigest() == '674a870e6cd42fdf08e72285649e10d9e2abffb2ecb5056e702fdd08c98dd094', 'Source bytes changed; annotations require review'
assert len(doc)==56 and '2012 (SXD)' in texts[0], 'Wrong document; review required'
pages=[dict(pdfPage=i+1,printedPage=i+1,text=t) for i,t in enumerate(texts)]
evidence=[]
def ev(page,quote,role):
    quote=norm(quote); assert quote in norm(texts[page-1]), (page,quote)
    key=(page,quote,role)
    for e in evidence:
        if (e['pdfPage'],e['quote'],e['role'])==key:return e['id']
    eid=f'e{len(evidence)+1}';evidence.append(dict(id=eid,pdfPage=page,printedPage=page,quote=quote,role=role));return eid
always={'op':'always'}
def eq(f,v=True):return dict(op='eq',field=f,value=v)
def anyof(*args):return dict(op='any',args=list(args))
primary=['primarily_dirt_dust','primarily_repeated_cold_short_trips','primarily_extensive_idling','primarily_low_speed_long_distance']
special=anyof(*(eq(f) for f in primary))
conditions={'normal':always,'dust':eq(primary[0]),'cold':eq(primary[1]),'idle':anyof(eq(primary[2]),eq(primary[3])),'non0':{'op':'not','arg':eq('oil_spec','0W-20')}}
intro=ev(34,'NOTE: You should perform these additional maintenance services only if the majority of your driving is done under the special operating conditions indicated. If you only occasionally drive under these circumstances, it is not necessary to perform the additional services.','condition')
trigger=ev(34,'Scion recommends obtaining scheduled maintenance for your vehicle every 5,000 miles or six months, whichever comes first.','trigger')
rows=[]; headings=[]; row_audit=[]
# Numbered footers govern the facing pair: even table pages cite the next
# odd page's footer. Preserve actual row markers, never infer all-item scope.
footnotes={}
for pn in range(37,52,2):
    footer=texts[pn-1].rsplit('MILEAGE:',1)[1].split('MAINTENANCE LOG')[0]
    footnotes[pn]={int(m[1]):ev(pn,m[0],'numbered_footnote') for m in re.finditer(r'(?ms)^(\d) .*?(?=^\d |\Z)',footer) }
assert all(footnotes.values()), 'Missing schedule footnotes'
# PDF text order is column-preserving (visually checked PDF36 and 39). Each
# schedule starts with its own heading, ends at dealer verification. Do not
# read across columns or mix footer notes into action rows.
for pn in range(36,52):
    text=texts[pn-1]
    matches=list(re.finditer(r'([\d,]+) miles or (\d+) months',text))
    for m in matches:
        miles=int(m[1].replace(',',''));months=int(m[2]);headings.append((miles,months,pn))
        h=ev(pn,m[0],'interval_heading')
        body=text[m.end():].split('DEALER SERVICE VERIFICATION:')[0]
        # Merge continuation lines; only true source row starts delimit rows.
        starts=r'(?m)^(?=Check installation|Inspect and adjust|Rotate tires|Visually inspect|Replace |Inspect (?!the following)|Tighten |__ |Note:|Additional Maintenance|Driving on|Repeated trips|Extensive idling|Inspect the following:)'
        chunks=[norm(x) for x in re.split(starts,body) if norm(x)]
        scope='normal'; scope_ref=None
        for chunk in chunks:
            if chunk.startswith('Additional Maintenance'):continue
            if chunk.startswith('Driving on'):scope='dust';scope_ref=ev(pn,chunk,'condition');continue
            if chunk.startswith('Repeated trips'):scope='cold';scope_ref=ev(pn,chunk,'condition');continue
            if chunk.startswith('Extensive idling'):scope='idle';scope_ref=ev(pn,chunk,'condition');continue
            if chunk.startswith('Inspect the following:'):continue
            row_scope=scope
            if chunk.startswith('Note:'):
                action='replace';service='Engine oil and oil filter';row_scope='non0'
            else:
                match=re.match(r'^(Check installation of|Inspect and adjust|Visually inspect|Inspect|Replace|Rotate|Tighten|__) (.+)',chunk)
                assert match,(pn,chunk)
                action={'Check installation of':'check','Inspect and adjust':'inspect_adjust','Visually inspect':'visually_inspect','Inspect':'inspect','Replace':'replace','Rotate':'rotate','Tighten':'tighten','__':'inspect'}[match[1]]
                service=re.sub(r'\s*\d+$','',match[2]).strip();service=service[0].upper()+service[1:]
            refs=[h,ev(pn,chunk,'service_row'),trigger]
            footer_page=pn if pn%2 else pn+1
            marker=re.search(r'(\d)$',chunk)
            if marker:refs.append(footnotes[footer_page][int(marker[1])])
            if row_scope in ['dust','cold','idle']:refs.append(footnotes[footer_page][2])
            if row_scope!='normal':refs.append(intro)
            if scope_ref:refs.append(scope_ref)
            rows.append(dict(service=service,action=action,scope=row_scope,miles=miles,months=months,pdfPage=pn,evidenceIds=list(dict.fromkeys(refs))))
        expected=len(re.findall(r'(?m)^(?:Check installation|Inspect and adjust|Rotate tires|Visually inspect|Replace |Inspect (?!the following)|Tighten |__ |Note:)',body))
        parsed=sum(r['miles']==miles for r in rows)
        assert expected==parsed,(pn,miles,expected,parsed)
        row_audit.append(dict(pdfPage=pn,miles=miles,sourceRowStarts=expected,parsedRows=parsed))
assert len(headings)==24 and sorted(x[0] for x in headings)==list(range(5000,120001,5000)), 'Incomplete schedule'
# The visual table inspection at each 30k calls for thickness/runout, not only visual checks.
measurement=ev(39,'3 Inspect thickness measurement and disc runout.','action_detail')
for r in rows:
    if r['service']=='Brake linings/drums and brake pads/discs' and r['action']=='inspect':r['evidenceIds'].append(measurement)
# De-duplicate schedule rows by semantic action/condition without inventing recurrence.
rules=[]
for r in rows:
    if r['service']=='Engine oil and oil filter':continue # represented by explicit oil explanations below
    key=(r['service'],r['action'],r['scope'])
    existing=next((x for x in rules if x['_key']==key),None)
    if existing is None:
        existing=dict(id=f'service-{len(rules)+1}',service=r['service'],action=r['action'],timing=dict(kind='milestones',anchor='vehicle_origin',trigger='whichever_first',points=[]),condition=conditions[r['scope']],evidenceIds=[],overrides=[],notes=[],_key=key);rules.append(existing)
    point=dict(miles=r['miles'],months=r['months'],evidenceIds=r['evidenceIds'])
    if point not in existing['timing']['points']:existing['timing']['points'].append(point)
    existing['evidenceIds']=list(dict.fromkeys(existing['evidenceIds']+r['evidenceIds']))
for r in rules:r.pop('_key');r['timing']['points'].sort(key=lambda p:p['miles'])
def add(rid,service,action,timing,condition,refs,notes=None,overrides=None):
    rules.append(dict(id=rid,service=service,action=action,timing=timing,condition=condition,evidenceIds=list(dict.fromkeys(refs)),overrides=overrides or [],notes=notes or []))
def recurring(miles=None,months=None):return dict(kind='recurring',anchor='source_instruction',trigger='whichever_first',interval={k:v for k,v in [('miles',miles),('months',months)] if v is not None})
oiltext=norm(texts[53]).split('NOTE:')[1].split('Exhaust Pipes and Mountings')[0]
oilref=ev(54,'NOTE:'+oiltext,'oil_specification_and_interval')
oilrows=list(dict.fromkeys(e for r in rows if r['service']=='Engine oil and oil filter' for e in r['evidenceIds']))
add('oil-normal','Engine oil and oil filter','replace',recurring(10000,12),eq('oil_spec','0W-20'),[oilref,trigger]+oilrows)
add('oil-substitute','Engine oil and oil filter','replace',recurring(5000,6),eq('oil_spec','5W-20 mineral'),[oilref,trigger],['Return to 0W-20 motor oil at this change.'],['oil-non0'])
non0rows=[r for r in rows if r['scope']=='non0']
add('oil-non0','Engine oil and oil filter','replace',dict(kind='milestones',anchor='vehicle_origin',trigger='whichever_first',points=[dict(miles=r['miles'],months=r['months'],evidenceIds=r['evidenceIds']) for r in non0rows]),conditions['non0'],[e for r in non0rows for e in r['evidenceIds']],['Only the listed non-0W-20 note milestones; no indefinite recurrence or approval of other oil grades inferred. Refer to Owner’s Manual for recommended grade and viscosity.'])
add('oil-special','Engine oil and oil filter','replace',recurring(5000,6),special,[oilref,intro,trigger]+oilrows,['Regardless of oil used. Majority/primarily only; not occasional use.'],['oil-normal','oil-substitute','oil-non0'])
# Explicit first/subsequent instructions override finite representations only where source says so.
for service,page,quote,first,subsequent in [
 ('Drive belts',43,'Initial inspection at 60,000 miles/72 months. Inspect every 15,000 miles/18 months thereafter.',(60000,72),(15000,18)),
 ('Engine coolant',49,'Initial replacement at 100,000 miles/120 months. Replace every 50,000 miles/60 months thereafter.',(100000,120),(50000,60))]:
    action='inspect' if service=='Drive belts' else 'replace'
    r=next(r for r in rules if r['service']==service and r['action']==action)
    r['timing']=dict(kind='first_subsequent',anchor='source_instruction',trigger='whichever_first',first=dict(miles=first[0],months=first[1]),subsequent=dict(miles=subsequent[0],months=subsequent[1]))
    r['evidenceIds'].append(ev(page,quote,'first_subsequent'))
    if service=='Engine coolant':
        r['condition']=eq('coolant_qualifies');r['evidenceIds'].append(ev(53,norm(texts[52]).split('Your Scion is equipped')[1].split('MAINTENANCE')[0].join(['Your Scion is equipped','']),'coolant_specification'))
        r['notes']=['Intervals depend on Genuine Toyota Super Long-Life Coolant or equivalent specified chemistry; other ethylene-glycol coolant may differ.']
# Full explanation passages preserved per named item, including condition-dependent corrective actions.
explanation_sections=[]
for pn in range(52,56):
    # Layout-aware column extraction prevents neighboring explanatory paragraphs mixing.
    page=doc[pn-1]
    for x0,x1 in [(35,198),(198,370)]:
        txt=page.get_text(clip=fitz.Rect(x0,65,x1,560))
        if norm(txt):explanation_sections.append(dict(pdfPage=pn,text=txt))
# Attach whole named explanatory spans from natural PDF text (headings delimit paragraphs).
names=['Ball Joints and Dust Covers','Brake Lines and Hoses','Brake Linings/Drums and Brake Pads/Discs','Drive Belts','Drive Shaft Boots','Driver’s Floor Mat','Engine Air Filter','Engine Coolant','Engine Oil and Oil Filter','Exhaust Pipes and Mountings','Front Differential Oil','Fuel Lines and Connections, Fuel Tank Band and Fuel Tank Vapor Vent System Hoses','Fuel Tank Cap Gasket','Nuts and Bolts on Chassis and Body','Radiator and Condenser','Spark Plugs','Steering Gear Box','Steering Linkage and Boots','Tire Rotation','Transmission Fluid or Oil']
explanations=[]
for pn in range(52,56):
    text=norm(texts[pn-1]);found=sorted((text.index(n),n) for n in names if n in text)
    for i,(start,name) in enumerate(found):
        end=found[i+1][0] if i+1<len(found) else text.index('MAINTENANCE',start) if 'MAINTENANCE' in text[start:] else len(text)
        quote=text[start:end].strip();eid=ev(pn,quote,'maintenance_explanation');explanations.append(dict(service=name,evidenceId=eid))
        aliases={'Tire Rotation':'Tires','Driver’s Floor Mat':'Driver’s floor mat'}
        matching=[r for r in rules if r['service'].lower()==aliases.get(name,name).lower() or (name=='Brake Linings/Drums and Brake Pads/Discs' and r['service']=='Brake linings/drums and brake pads/discs')]
        for r in matching:r['evidenceIds'].append(eid)
        # Preserve actionable condition-driven explanation, never manufacture periodic replacements.
        if re.search(r'replace|repair|adjust|clean|tighten',quote,re.I) and name not in ['Engine Oil and Oil Filter','Spark Plugs','Nuts and Bolts on Chassis and Body']:
            for verb in ['replace','repair','adjust','clean','tighten']:
                if re.search(r'\b'+verb+r'(?:d|ed)?\b',quote,re.I):
                    subject=aliases.get(name,name)
                    if name=='Engine Coolant':subject={'replace':'Cooling system damaged parts','clean':'Radiator, condenser and/or intercooler','tighten':'Cooling system connections'}[verb]
                    if name=='Front Differential Oil':subject='Front differential leakage'
                    if name=='Transmission Fluid or Oil':subject='Transmission leakage'
                    add('explanation-'+str(len(rules)+1),subject,verb,dict(kind='monitor',mode='inspection_finding',instruction=quote),eq('finding_'+re.sub(r'[^a-z0-9]+','_',name.lower())+'_'+verb),[eid],['Condition-driven corrective action; no periodic interval inferred. Qualified technician where specified.'])
level=ev(33,'routinely check your vehicle’s engine oil level (once a month)','interval')
add('oil-level','Engine oil level','check',recurring(months=1),always,[level])
reset=ev(37,'Reset the oil replacement reminder light (“MAINT REQD”) or the message “OIL MAINTENANCE REQUIRED” on the multi-information display after maintenance at every 5,000 miles.','monitor_instruction')
add('reset-reminder','Oil replacement reminder','reset',dict(kind='monitor',mode='reset_reminder',instruction='Reset after maintenance at every 5,000 miles; this is not evidence an oil change is required.'),always,[reset])
questions=[dict(field='oil_spec',prompt='Exact oil specification used at the last oil change (not just synthetic)?',values=['0W-20','5W-20 mineral'],unknownAllowed=True),dict(field='coolant_qualifies',prompt='Genuine Toyota Super Long-Life Coolant or matching non-silicate/non-amine/non-borate ethylene glycol long-life hybrid organic acid chemistry?',unknownAllowed=True)]
for field,prompt in zip(primary,['Is the majority of driving on dirt or dusty roads?','Is the majority of driving repeated trips of less than five miles in temperatures below 32°F / 0°C?','Is the majority of driving extensive idling (e.g., police, taxi, delivery)?','Is the majority of driving low speed for a long distance (e.g., police, taxi, delivery)?']):questions.append(dict(field=field,prompt=prompt,unknownAllowed=True))
# Qualified boolean predicates have explicit machine-readable definitions, not generic severe-use flags.
questions[3]['definition']=dict(op='all',args=[dict(op='eq',field='driving_frequency',value='primarily'),dict(op='eq',field='repeated_trips',value=True),dict(op='lt',field='trip_distance_miles',value=5),dict(op='lt',field='ambient_temperature_c',value=0)])
for r in rules:
    c=r['condition']
    if c.get('field','').startswith('finding_'):questions.append(dict(field=c['field'],prompt='Has the inspection established the condition requiring this action? '+r['timing']['instruction'],unknownAllowed=True))
# Additional explicit non-periodic care instructions, not invented mileage tasks.
grease=next(e for e in explanations if e['service']=='Drive Shaft Boots')['evidenceId']
add('boots-repack','Drive shaft boots grease','repack',dict(kind='monitor',mode='inspection_finding',instruction='If necessary, repack the grease; qualified technician.'),eq('finding_boots_repack'),[grease])
wheel=ev(35,norm(texts[34]).split('If you purchased')[1].split('MAINTENANCE')[0].join(['If you purchased','']),'accessory_care')
add('accessory-wheel-clean','Genuine Toyota accessory aluminum alloy wheels','clean',dict(kind='monitor',mode='care_instruction',instruction='Wait for hot wheels to cool. Soft sponge/cotton cloth and mild car-wash soap; rinse promptly. Do not use chemical cleaners, alcohol, solvents, gasoline, steam, scouring pads, wire brushes or coarse abrasives.'),eq('accessory_alloy_wheels'),[wheel])
add('accessory-wheel-wax','Genuine Toyota accessory aluminum alloy wheels','wax',dict(kind='monitor',mode='care_instruction',instruction='Use a soft cloth to apply the same car wax as used for the vehicle body.'),eq('accessory_alloy_wheels'),[wheel])
questions.append(dict(field='accessory_alloy_wheels',prompt='Are these genuine Toyota accessory aluminum alloy wheels?',unknownAllowed=True))
questions.append(dict(field='finding_boots_repack',prompt='Has inspection established that drive shaft boot grease repacking is necessary?',unknownAllowed=True))
# Persist raw rows before aggregation for coverage and reproducible audit.
sha=hashlib.sha256(PDF.read_bytes()).hexdigest()
template=dict(schemaVersion=1,templateId='scion-2012-xd-'+sha[:16],applicability=dict(year=2012,make='Scion',model='xD',engine=None,transmission=None,market='US'),source=dict(id='uploaded-2012-Scion-xD-WMG',title='2012 Scion xD Warranty and Maintenance Guide',version='2012 (SXD); PDF creation 2011-08-01',sha256=sha,pageCount=len(doc),provenance='owner_uploaded_pdf; deterministic row parser plus source-reviewed semantic annotations; not AI-generated or remote-byte authenticated'),pages=pages,evidence=evidence,rules=rules,ownerQuestions=questions,unresolved=[dict(code='OTHER_OIL_SPEC',message='Other/unknown oil specification does not establish eligibility for the extended interval.'),dict(code='COOLANT_OTHER',message='Alternative coolant may require different intervals; no alternative interval provided.'),dict(code='IDENTITY_SCOPE',message='2012 (SXD) publication marking and uploaded filename identify this attachment; engine/transmission not specified. Verify application before reuse.'),dict(code='HISTORY_UNKNOWN',message='No owner history or in-service date inferred. Finite milestones do not imply overdue or missed maintenance.')],coverage=dict(scheduleMilestones=len(headings),rawScheduleRows=len(rows),deduplicatedRules=len(rules),explanationItems=len(explanations),schedulePdfPages=list(range(36,52)),explanationPdfPages=list(range(52,56)),reviewedImages=[34,36,39,43,49,51,52,53,54,55],completeScheduleRows=True,unparsedScheduleRows=sum(a['sourceRowStarts']-a['parsedRows'] for a in row_audit),sourceFootnotesAudited=True,semanticReview='Exact-source authored annotations, not automated semantic inference; non-0W20 notes mapped to finite milestones; no approval of other grades inferred; unknown oil requires information',allPagesRetained=len(pages)==len(doc)),explanations=explanations)
for filename,value in [('scion-2012-xd-template.json',template),('scion-2012-xd-source-rows.json',dict(rows=rows,headings=headings,explanations=explanations,rowAudit=row_audit,footnotes=footnotes,sourceSha256=sha))]:
    (OUT/filename).write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
# Backend-owned reviewed catalog is separate from caller-supplied template JSON.
# Re-running this exact-source compiler updates it; changes must be reviewed as code.
catalog={k:template[k] for k in ['schemaVersion','templateId','applicability','source','pages','rules','ownerQuestions','evidence','coverage','unresolved','explanations']}
catalog_path=pathlib.Path(__file__).resolve().parents[1]/'supabase/functions/_shared/maintenance-template-catalog.js'
catalog_path.write_text('// Generated by exact-source Scion compiler; source-reviewed annotations, not model proof.\nexport const reviewedTemplateCatalog = '+json.dumps({sha:catalog},ensure_ascii=False,separators=(',',':'))+'\n')
print(json.dumps(template['coverage'],indent=2))
