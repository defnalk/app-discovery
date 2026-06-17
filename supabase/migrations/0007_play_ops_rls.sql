-- Phase 2 ops hardening. Additive + idempotent.
-- (a) Atomic, race-safe claim RPC. (b) Seed admins. (c) RLS lockdown that CLOSES a
-- verified hole: the publishable/anon key could SELECT/INSERT/UPDATE/DELETE the
-- play_* tables. After this, only service_role (the serverless functions) can touch
-- them. service_role bypasses RLS, so the functions keep working.

-- (a) claim_play: exactly one of two simultaneous claims wins, arbitrated by the
-- UNIQUE(subject_type,subject_id) index. SECURITY DEFINER so it runs as the table
-- owner and is unaffected by the deny-all RLS below.
create or replace function claim_play(
  p_subject_type text,
  p_subject_id   text,
  p_subject_name text,
  p_category     text,
  p_manager      text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      play_claims;
  v_existing play_claims;
begin
  insert into play_claims (subject_type, subject_id, subject_name, category, manager_name, status, claimed_at, start_by)
  values (p_subject_type, p_subject_id, p_subject_name, p_category, p_manager, 'reserved', now(), now() + interval '24 hours')
  on conflict (subject_type, subject_id) do nothing
  returning * into v_row;

  if v_row.id is not null then
    return jsonb_build_object('won', true, 'claim', to_jsonb(v_row));
  end if;

  select * into v_existing from play_claims
   where subject_type = p_subject_type and subject_id = p_subject_id;
  return jsonb_build_object('won', false, 'claimed_by', v_existing.manager_name, 'claim', to_jsonb(v_existing));
end;
$$;

-- (b) Seed admins (Defne + Hussain).
insert into play_managers (name, role) values ('Defne', 'admin'), ('Hussain', 'admin')
  on conflict (name) do update set role = 'admin';

-- (c) RLS lockdown: enable RLS (deny-all by default, no policies) + revoke table
-- grants from the public API roles. The publishable key then has zero access.
alter table play_managers     enable row level security;
alter table play_claims       enable row level security;
alter table play_submissions  enable row level security;
alter table idea_radar        enable row level security;
revoke all on play_managers    from anon, authenticated;
revoke all on play_claims      from anon, authenticated;
revoke all on play_submissions from anon, authenticated;
revoke all on idea_radar       from anon, authenticated;
-- defense in depth: only service_role may execute the claim RPC.
revoke all on function claim_play(text, text, text, text, text) from anon, authenticated;
