-- LOCAL ONLY / UNAPPLIED. Add a separate unreviewed lane; do not relax reviewed catalog gates.
begin;
create function public.gate_document_maintenance_proposal() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  if new.schema_version='manufacturer-template-v2' then
    if new.status not in ('needs_review','extraction_failed')
      or new.record->>'source_authenticity' not in ('user_uploaded_unverified','provider_citation_unconfirmed')
      or new.record#>'{validation_report,source_support_checked}' is distinct from 'false'::jsonb
      or new.record#>'{validation_report,auto_apply_allowed}' is distinct from 'false'::jsonb then
      raise exception 'Document proposals are unreviewed and cannot be applied' using errcode='22023';
    end if;
    if new.record#>'{payload,schemaVersion}' is distinct from '2'::jsonb
      or new.record#>>'{payload,sourceSha256}' is distinct from new.source_sha256
      or new.record#>>'{payload,source,sha256}' is distinct from new.source_sha256
      or new.record#>>'{payload,source,id}' is distinct from new.source_document_id
      or new.record#>>'{payload,source,version}' is distinct from new.source_version
      or new.record#>'{payload,applicability}' is distinct from new.applicability then
      raise exception 'Document proposal source/applicability identity mismatch' using errcode='22023';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.gate_document_maintenance_proposal() from public,anon,authenticated,service_role;
create trigger manufacturer_template_document_proposal_gate before insert on public.manufacturer_template_versions
for each row execute function public.gate_document_maintenance_proposal();
commit;
