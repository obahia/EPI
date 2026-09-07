-- Phase F: panel-facing management of integration principals and API keys.
--
-- These are the ONLY way a principal or a key is ever created, changed or revoked, and they
-- are reachable only by a human ORG_ADMIN. Deliberately absent: any API endpoint that
-- manages keys or webhook endpoints. A key that can mint keys, or point a webhook somewhere
-- new, is self-escalating -- that stays a human, panel-only action in this phase.
--
-- Reads are functions rather than api.* views on purpose: every other api.* view is
-- security_invoker over app/authz/..., which requires the caller to hold SELECT on the
-- underlying table. m2m.* grants SELECT to nobody, and it should stay that way, so these
-- are SECURITY DEFINER functions that do their own authorization instead.

create function api.create_integration_principal(
  p_organization_id uuid,
  p_name text,
  p_company_ids uuid[] default null,
  p_scopes text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_scopes m2m.api_scope[];
  v_bad_count int;
begin
  if not (select auth_ctx.has_org_permission(p_organization_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- The cast is the allowlist: an unrecognised scope fails here, at write time, rather than
  -- silently sitting in a column until someone wonders why a call is refused.
  begin
    v_scopes := p_scopes::m2m.api_scope[];
  exception when others then
    raise exception 'unknown_scope' using errcode = '22P02';
  end;

  if p_company_ids is not null then
    select count(*) into v_bad_count
    from unnest(p_company_ids) as cid
    where not exists (
      select 1 from app.companies c
      where c.id = cid and c.organization_id = p_organization_id and c.archived_at is null
    );
    if v_bad_count > 0 then
      raise exception 'company_out_of_scope' using errcode = '23514';
    end if;
  end if;

  if (select count(*) from m2m.integration_principals
       where organization_id = p_organization_id and status = 'ACTIVE') >= 20 then
    raise exception 'too_many_principals' using errcode = '54000';
  end if;

  insert into m2m.integration_principals (organization_id, name, company_ids, scopes, created_by)
  values (p_organization_id, btrim(p_name), p_company_ids, v_scopes, (select auth.uid()))
  returning id into v_id;

  perform app.log_audit_event(
    p_organization_id, null, 'API_PRINCIPAL_CREATED', 'm2m.integration_principals', v_id,
    'USER', (select auth.uid()),
    jsonb_build_object('name', btrim(p_name), 'scopes', to_jsonb(p_scopes),
                       'company_scoped', p_company_ids is not null)
  );

  return v_id;
exception
  when unique_violation then
    raise exception 'principal_name_taken' using errcode = '23505';
end;
$$;

comment on function api.create_integration_principal(uuid, text, uuid[], text[]) is
  'Creates a machine principal. ORG_ADMIN only, and only through an org-wide membership. Scopes are validated against the m2m.api_scope allowlist at write time.';

revoke execute on function api.create_integration_principal(uuid, text, uuid[], text[]) from public, anon;
grant execute on function api.create_integration_principal(uuid, text, uuid[], text[]) to authenticated;

create function api.update_integration_principal(
  p_principal_id uuid,
  p_name text,
  p_company_ids uuid[],
  p_scopes text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_scopes m2m.api_scope[];
  v_bad_count int;
begin
  select organization_id into v_org_id from m2m.integration_principals
   where id = p_principal_id and status = 'ACTIVE';
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  begin
    v_scopes := p_scopes::m2m.api_scope[];
  exception when others then
    raise exception 'unknown_scope' using errcode = '22P02';
  end;

  if p_company_ids is not null then
    select count(*) into v_bad_count
    from unnest(p_company_ids) as cid
    where not exists (
      select 1 from app.companies c
      where c.id = cid and c.organization_id = v_org_id and c.archived_at is null
    );
    if v_bad_count > 0 then
      raise exception 'company_out_of_scope' using errcode = '23514';
    end if;
  end if;

  -- organization_id is never updatable: a principal's tenant is its identity, and moving it
  -- would silently re-point every key already issued for it.
  update m2m.integration_principals
     set name = btrim(p_name), company_ids = p_company_ids, scopes = v_scopes
   where id = p_principal_id;

  perform app.log_audit_event(
    v_org_id, null, 'API_PRINCIPAL_UPDATED', 'm2m.integration_principals', p_principal_id,
    'USER', (select auth.uid()),
    jsonb_build_object('name', btrim(p_name), 'scopes', to_jsonb(p_scopes),
                       'company_scoped', p_company_ids is not null)
  );
end;
$$;

revoke execute on function api.update_integration_principal(uuid, text, uuid[], text[]) from public, anon;
grant execute on function api.update_integration_principal(uuid, text, uuid[], text[]) to authenticated;

create function api.revoke_integration_principal(p_principal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from m2m.integration_principals
   where id = p_principal_id and status = 'ACTIVE';
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  update m2m.integration_principals
     set status = 'REVOKED', revoked_at = now(), revoked_by = (select auth.uid())
   where id = p_principal_id;

  -- Revoking the principal revokes every key it owns. A key outliving its principal would
  -- be a credential with no subject.
  update m2m.api_keys
     set revoked_at = now(), revoked_by = (select auth.uid()),
         revoke_reason = coalesce(revoke_reason, 'principal revoked')
   where principal_id = p_principal_id and revoked_at is null;

  perform app.log_audit_event(
    v_org_id, null, 'API_PRINCIPAL_REVOKED', 'm2m.integration_principals', p_principal_id,
    'USER', (select auth.uid()), '{}'::jsonb
  );
end;
$$;

revoke execute on function api.revoke_integration_principal(uuid) from public, anon;
grant execute on function api.revoke_integration_principal(uuid) to authenticated;

-- The secret itself is generated in Node (CSPRNG) and hashed there with API_KEY_PEPPER --
-- exactly the worker-token discipline. Postgres receives only the hash and never has the
-- material needed to reconstruct a usable key, so a database dump alone is not enough.
create function api.create_api_key(
  p_principal_id uuid,
  p_key_id text,
  p_secret_hash_b64 text,
  p_env text default 'live',
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_id uuid;
begin
  select organization_id into v_org_id from m2m.integration_principals
   where id = p_principal_id and status = 'ACTIVE';
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Ten is generous enough for overlapping rotation and small enough that keys cannot
  -- silently accumulate past the point where anyone knows what they are for.
  if (select count(*) from m2m.api_keys
       where principal_id = p_principal_id and revoked_at is null) >= 10 then
    raise exception 'too_many_keys' using errcode = '54000';
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'expires_in_the_past' using errcode = '23514';
  end if;

  insert into m2m.api_keys (principal_id, key_id, secret_hash, env, expires_at, created_by)
  values (p_principal_id, p_key_id, decode(p_secret_hash_b64, 'base64'), p_env,
          p_expires_at, (select auth.uid()))
  returning id into v_id;

  perform app.log_audit_event(
    v_org_id, null, 'API_KEY_CREATED', 'm2m.api_keys', v_id,
    'USER', (select auth.uid()),
    jsonb_build_object('key_id', p_key_id, 'env', p_env, 'principal_id', p_principal_id,
                       'expires_at', p_expires_at)
  );

  return v_id;
exception
  when unique_violation then
    raise exception 'key_id_taken' using errcode = '23505';
end;
$$;

comment on function api.create_api_key(uuid, text, text, text, timestamptz) is
  'Registers an API key. Receives ONLY the peppered hash of the secret -- the secret is shown once by the caller and is unrecoverable afterwards from anywhere, including this database. The audit event records the public key_id, never the hash.';

revoke execute on function api.create_api_key(uuid, text, text, text, timestamptz) from public, anon;
grant execute on function api.create_api_key(uuid, text, text, text, timestamptz) to authenticated;

create function api.revoke_api_key(p_api_key_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_key_id text;
begin
  select p.organization_id, k.key_id into v_org_id, v_key_id
    from m2m.api_keys k
    join m2m.integration_principals p on p.id = k.principal_id
   where k.id = p_api_key_id and k.revoked_at is null;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Irreversible by design: there is no un-revoke. Recovering from an accidental revoke
  -- means issuing a new key, which is exactly the same work as rotating one.
  update m2m.api_keys
     set revoked_at = now(), revoked_by = (select auth.uid()), revoke_reason = p_reason
   where id = p_api_key_id;

  perform app.log_audit_event(
    v_org_id, null, 'API_KEY_REVOKED', 'm2m.api_keys', p_api_key_id,
    'USER', (select auth.uid()),
    jsonb_build_object('key_id', v_key_id, 'reason', p_reason)
  );
end;
$$;

revoke execute on function api.revoke_api_key(uuid, text) from public, anon;
grant execute on function api.revoke_api_key(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------
create function api.list_integration_principals(p_organization_id uuid)
returns table (
  id uuid, name text, company_ids uuid[], scopes text[], status text,
  created_at timestamptz, revoked_at timestamptz, active_key_count int, last_used_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not (select auth_ctx.has_org_permission(p_organization_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
    select p.id, p.name, p.company_ids, p.scopes::text[], p.status,
           p.created_at, p.revoked_at,
           (select count(*)::int from m2m.api_keys k
             where k.principal_id = p.id and k.revoked_at is null),
           (select max(k.last_used_at) from m2m.api_keys k where k.principal_id = p.id)
      from m2m.integration_principals p
     where p.organization_id = p_organization_id
     order by p.created_at desc;
end;
$$;

revoke execute on function api.list_integration_principals(uuid) from public, anon;
grant execute on function api.list_integration_principals(uuid) to authenticated;

create function api.list_api_keys(p_principal_id uuid)
returns table (
  id uuid, key_id text, env text, created_at timestamptz, last_used_at timestamptz,
  last_used_ip inet, expires_at timestamptz, revoked_at timestamptz, revoke_reason text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  select organization_id into v_org_id from m2m.integration_principals where id = p_principal_id;
  if v_org_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (select auth_ctx.has_org_permission(v_org_id, 'integration.manage')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- secret_hash is deliberately not in the RETURNS list. It has no legitimate reader:
  -- verification happens inside m2m.resolve_principal, never in the application layer.
  return query
    select k.id, k.key_id, k.env, k.created_at, k.last_used_at, k.last_used_ip,
           k.expires_at, k.revoked_at, k.revoke_reason
      from m2m.api_keys k
     where k.principal_id = p_principal_id
     order by k.created_at desc;
end;
$$;

revoke execute on function api.list_api_keys(uuid) from public, anon;
grant execute on function api.list_api_keys(uuid) to authenticated;
