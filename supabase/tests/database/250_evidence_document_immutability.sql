-- PILOT READINESS P1-1. The attack this suite exists to make impossible:
--
--   update evidence.documents set evidence_version_id = <another version> where verification_code = 'ABC…';
--
-- If that succeeded, a receipt already printed and handed to a worker -- whose QR points at
-- /verify/<code> -- would start verifying against different content. The sealed evidence would
-- be untouched, every hash would still check out, and the chain would still be intact. The
-- forgery would be invisible exactly because the part everyone inspects was never altered.
--
-- These fixtures write straight into evidence.* as the owner rather than going through a
-- delivery: evidence_versions has no foreign keys on its tenant columns, so a two-row fixture
-- is enough, and the point here is the TABLE's behaviour, not the sealing flow (which
-- 050_evidence_sealing.sql already covers). Writing as the owner is also the harder test --
-- the whole claim is that the trigger raises even for the role that owns the table.

create extension if not exists pgtap with schema extensions;

begin;

select plan(14);

create temporary table probe (label text primary key, val text);
grant all on probe to authenticated;

-- Two sealed evidence versions: the one the receipt legitimately points at, and the one an
-- attacker would want to repoint it to.
insert into evidence.evidence_versions (
  id, organization_id, company_id, delivery_id, confirmation_request_id,
  chain_id, chain_version, payload, canonical_bytes, payload_sha256,
  audit_seq, audit_event_hash, sealed_at
) values
  ('e0000000-0000-4000-8000-00000000000a',
   'aaaa0000-0000-4000-8000-00000000000a', 'aaaa0000-0000-4000-8000-00000000000b',
   'dddd0000-0000-4000-8000-00000000000a', 'cccc0000-0000-4000-8000-00000000000a',
   'ffff0000-0000-4000-8000-00000000000a', 1,
   '{"real":true}'::jsonb, convert_to('{"real":true}', 'UTF8'),
   extensions.digest(convert_to('{"real":true}', 'UTF8'), 'sha256'),
   1, extensions.digest('a', 'sha256'), now()),
  ('e0000000-0000-4000-8000-00000000000b',
   'aaaa0000-0000-4000-8000-00000000000a', 'aaaa0000-0000-4000-8000-00000000000b',
   'dddd0000-0000-4000-8000-00000000000b', 'cccc0000-0000-4000-8000-00000000000b',
   'ffff0000-0000-4000-8000-00000000000b', 1,
   '{"forged":true}'::jsonb, convert_to('{"forged":true}', 'UTF8'),
   extensions.digest(convert_to('{"forged":true}', 'UTF8'), 'sha256'),
   2, extensions.digest('b', 'sha256'), now());

-- ---------------------------------------------------------------------------------------
-- The legitimate flow still works. A trigger that broke sealing would be a worse bug than
-- the one it fixes, so this is asserted first.
-- ---------------------------------------------------------------------------------------
do $$
begin
  insert into evidence.documents (organization_id, company_id, evidence_version_id, verification_code)
  values ('aaaa0000-0000-4000-8000-00000000000a', 'aaaa0000-0000-4000-8000-00000000000b',
          'e0000000-0000-4000-8000-00000000000a', 'ABCDEFGH2345');
  insert into probe values ('issue', 'ALLOWED');
exception when others then insert into probe values ('issue', sqlstate || ' ' || sqlerrm);
end $$;

select is((select val from probe where label = 'issue'), 'ALLOWED',
  'a document can still be ISSUED -- the fix must not break app.seal_evidence, which is the only writer');

-- ---------------------------------------------------------------------------------------
-- The attack, in its three shapes, as the table OWNER.
-- ---------------------------------------------------------------------------------------
do $$
begin
  begin
    update evidence.documents
       set evidence_version_id = 'e0000000-0000-4000-8000-00000000000b'
     where verification_code = 'ABCDEFGH2345';
    insert into probe values ('repoint', 'ALLOWED');
  exception when others then insert into probe values ('repoint', sqlstate); end;

  begin
    update evidence.documents set verification_code = 'ZZZZZZZZ9999'
     where verification_code = 'ABCDEFGH2345';
    insert into probe values ('recode', 'ALLOWED');
  exception when others then insert into probe values ('recode', sqlstate); end;

  begin
    delete from evidence.documents where verification_code = 'ABCDEFGH2345';
    insert into probe values ('delete', 'ALLOWED');
  exception when others then insert into probe values ('delete', sqlstate); end;

  -- The same row reached through its primary key rather than the code, in case anyone ever
  -- assumes the protection is somehow bound to the lookup column.
  begin
    update evidence.documents d
       set evidence_version_id = 'e0000000-0000-4000-8000-00000000000b'
     where d.id = (select d2.id from evidence.documents d2 where d2.verification_code = 'ABCDEFGH2345');
    insert into probe values ('repoint_by_id', 'ALLOWED');
  exception when others then insert into probe values ('repoint_by_id', sqlstate); end;
end $$;

select is((select val from probe where label = 'repoint'), '42501',
  'an issued verification_code CANNOT be repointed at another evidence version -- the forgery this suite exists for');
select is((select val from probe where label = 'recode'), '42501',
  'nor can the code itself be rewritten onto a different receipt');
select is((select val from probe where label = 'delete'), '42501',
  'nor can an issued document be deleted');
select is((select val from probe where label = 'repoint_by_id'), '42501',
  'and reaching the same row by primary key instead of by code changes nothing');

-- ---------------------------------------------------------------------------------------
-- Nothing moved. A refusal that still left the row altered would be worthless.
-- ---------------------------------------------------------------------------------------
select is(
  (select d.evidence_version_id from evidence.documents d where d.verification_code = 'ABCDEFGH2345'),
  'e0000000-0000-4000-8000-00000000000a'::uuid,
  'after every attempt the receipt still points at the evidence it was sealed with');

select is(
  (select count(*)::int from evidence.documents d
    where d.evidence_version_id = 'e0000000-0000-4000-8000-00000000000b'),
  0,
  'and nothing points at the version the attacker wanted to substitute');

select is(
  (select ev.payload ->> 'real' from evidence.evidence_versions ev
     join evidence.documents d on d.evidence_version_id = ev.id
    where d.verification_code = 'ABCDEFGH2345'),
  'true',
  'so /verify/<code> still resolves to the real payload, not the forged one');

-- ---------------------------------------------------------------------------------------
-- The same three attempts as an ordinary application role.
-- ---------------------------------------------------------------------------------------
do $$
begin
  set local role authenticated;
  begin
    update evidence.documents set evidence_version_id = 'e0000000-0000-4000-8000-00000000000b';
    insert into probe values ('auth_update', 'ALLOWED');
  exception when others then insert into probe values ('auth_update', sqlstate); end;
  begin
    delete from evidence.documents;
    insert into probe values ('auth_delete', 'ALLOWED');
  exception when others then insert into probe values ('auth_delete', sqlstate); end;
  begin
    insert into evidence.documents (organization_id, company_id, evidence_version_id, verification_code)
    values ('aaaa0000-0000-4000-8000-00000000000a', 'aaaa0000-0000-4000-8000-00000000000b',
            'e0000000-0000-4000-8000-00000000000b', 'QQQQQQQQ7777');
    insert into probe values ('auth_insert', 'ALLOWED');
  exception when others then insert into probe values ('auth_insert', sqlstate); end;
  reset role;
end $$;

select is((select val from probe where label = 'auth_update'), '42501',
  'authenticated cannot update an issued document');
select is((select val from probe where label = 'auth_delete'), '42501',
  'nor delete one');
select is((select val from probe where label = 'auth_insert'), '42501',
  'nor mint one -- issuing a receipt is app.seal_evidence''s job and nobody else''s');

-- ---------------------------------------------------------------------------------------
-- Regression guards: the sibling table keeps its protection, and the trigger that makes all
-- of the above true is present in the catalogue. A future migration that drops it fails here
-- rather than silently reopening the hole.
-- ---------------------------------------------------------------------------------------
do $$
begin
  begin
    update evidence.evidence_versions set payload = '{"tampered":true}'::jsonb;
    insert into probe values ('version_update', 'ALLOWED');
  exception when others then insert into probe values ('version_update', sqlstate); end;
end $$;

select is((select val from probe where label = 'version_update'), '42501',
  'the sealed evidence itself is still immutable too');

select is(
  (select count(*)::int from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'evidence' and c.relname = 'documents'
      and not t.tgisinternal and t.tgname = 'documents_no_update_delete'),
  1,
  'the trigger is present in the catalogue, so dropping it in a later migration fails this suite');

select is(
  (select count(*)::int from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     join pg_roles r on r.oid = a.grantee
    where n.nspname = 'evidence' and c.relname = 'documents'
      and r.rolname in ('authenticated', 'anon', 'service_role')),
  0,
  'and no application role holds any privilege on the table at all, service_role included');

select * from finish();

rollback;
