-- FASE 0: RLS helper functions. This is the single most performance- and
-- security-load-bearing migration in the schema -- see docs/architecture.md §7 for the
-- full reasoning. Read the comments on each function; they are not decorative.

-- auth_ctx.company_ids(): every company id the CURRENT caller can act on, optionally
-- filtered by a specific permission. SECURITY DEFINER + owned by the table owner is what
-- lets this read authz.memberships (which has zero grants to authenticated/anon) without
-- ever triggering evaluation of a policy on that table -- the recursion the classic
-- Supabase RLS bug is made of is structurally impossible here, not merely avoided.
create function auth_ctx.company_ids(p_permission text default null)
returns uuid[]
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct c.id), '{}'::uuid[])
  from authz.memberships m
  join app.companies c
    on c.organization_id = m.organization_id
   and (m.company_id is null or c.id = m.company_id)
  where m.user_id = (select auth.uid())
    and m.revoked_at is null
    and c.archived_at is null
    and (
      p_permission is null
      or exists (
        select 1 from authz.role_permissions rp
        where rp.role = m.role and rp.permission = p_permission
      )
    );
$$;

comment on function auth_ctx.company_ids(text) is
  'Every company_id the current auth.uid() can act on (optionally requiring a specific permission), expanding a company_id IS NULL membership into every company of that organization. ALWAYS call as (select auth_ctx.company_ids()) inside a policy -- the (select ...) wrapper is what turns this into a once-per-statement InitPlan instead of a once-per-row re-evaluation. Enforced by a CI grep, not by memory.';

create function auth_ctx.organization_ids()
returns uuid[]
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct m.organization_id), '{}'::uuid[])
  from authz.memberships m
  where m.user_id = (select auth.uid())
    and m.revoked_at is null;
$$;

comment on function auth_ctx.organization_ids() is
  'Every organization_id the current auth.uid() belongs to. Used for org-scoped tables (organizations itself, future integration_connections, epis with company_id IS NULL, etc).';

create function auth_ctx.has_permission(p_company_id uuid, p_permission text)
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select p_company_id is not null and exists (
    select 1
    from authz.memberships m
    join app.companies c
      on c.organization_id = m.organization_id
     and (m.company_id is null or c.id = m.company_id)
    join authz.role_permissions rp on rp.role = m.role and rp.permission = p_permission
    where m.user_id = (select auth.uid())
      and m.revoked_at is null
      and c.id = p_company_id
      and c.archived_at is null
  );
$$;

comment on function auth_ctx.has_permission(uuid, text) is
  'True iff the current user holds p_permission for p_company_id. Used in WITH CHECK clauses for writes, e.g. (select auth_ctx.has_permission(company_id, ''delivery.issue'')).';

create function auth_ctx.co_member_user_ids()
returns uuid[]
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct theirs.user_id), '{}'::uuid[])
  from authz.memberships mine
  join authz.memberships theirs on theirs.organization_id = mine.organization_id
  where mine.user_id = (select auth.uid())
    and mine.revoked_at is null
    and theirs.revoked_at is null;
$$;

comment on function auth_ctx.co_member_user_ids() is
  'Every user_id sharing at least one live organization membership with the caller. Exists specifically so app.users RLS policies never reference authz.memberships directly -- a policy''s USING clause runs with the CALLER''s own privileges on referenced tables, so a direct join there would require granting authenticated a read on authz.memberships, which is never done (see docs/architecture.md §7).';

create function auth_ctx.is_platform_admin()
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.platform_admins pa
    where pa.user_id = (select auth.uid()) and pa.revoked_at is null
  );
$$;

comment on function auth_ctx.is_platform_admin() is
  'True iff the current user is an active platform admin. NOT used to bypass RLS -- see docs/architecture.md §5. Used only to gate the break-glass grant UI and the platform_access_grants policies.';

revoke execute on function auth_ctx.company_ids(text) from public, anon;
revoke execute on function auth_ctx.organization_ids() from public, anon;
revoke execute on function auth_ctx.has_permission(uuid, text) from public, anon;
revoke execute on function auth_ctx.co_member_user_ids() from public, anon;
revoke execute on function auth_ctx.is_platform_admin() from public, anon;

grant execute on function auth_ctx.company_ids(text) to authenticated;
grant execute on function auth_ctx.organization_ids() to authenticated;
grant execute on function auth_ctx.has_permission(uuid, text) to authenticated;
grant execute on function auth_ctx.co_member_user_ids() to authenticated;
grant execute on function auth_ctx.is_platform_admin() to authenticated;
